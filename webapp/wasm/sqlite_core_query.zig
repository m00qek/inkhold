//! The query, read once for both passes: its tokens folded by the index's
//! tokenizer, which of them sit inside quotes, and the MATCH expression made
//! from them. A document page is a set of words, so there a quoted phrase is
//! only its words (`phrase.ts` checks the order against the page's text);
//! every other row is running text, where the phrase is held to its order.

const std = @import("std");
const spd = @import("spd");
const c = spd.sqlite.c;

/// One whitespace-separated piece of the query, between or inside quotes.
pub const Token = struct {
    /// As typed, for the UI.
    raw: []const u8,
    /// What the tokenizer folds it to; empty for punctuation.
    terms: []const []const u8,
    /// Its index in `Scan.phrases` when it sits inside quotes.
    phrase: ?usize,
    /// The last token with terms, in an open-ended query: matched as a start.
    prefix: bool = false,
};

/// The tokens `[first, end)` inside one pair of quotes.
pub const Phrase = struct {
    first: usize,
    end: usize,
    /// The closing quote is typed: the last word is whole.
    closed: bool,
    /// Terms across its tokens; a phrase needs two, one quoted word is a word.
    terms: usize,
};

pub const Scan = struct {
    tokens: []Token,
    phrases: []Phrase,

    /// A phrase the text rows must hold in order.
    pub fn hasPhrase(s: Scan) bool {
        for (s.phrases) |p| if (p.terms >= 2) return true;
        return false;
    }
};

/// The fold every token goes through: the index's tokenizer, `0` or `-rc`.
pub const FoldFn = *const fn (*c.sqlite3, std.mem.Allocator, []const u8, *std.ArrayList([]const u8)) i32;

/// Reads `query` into `out`, allocating from `arena`. Returns 0 or `-rc`.
pub fn scan(h: *c.sqlite3, arena: std.mem.Allocator, fold: FoldFn, query: []const u8, out: *Scan) i32 {
    var tokens: std.ArrayList(Token) = .empty;
    var phrases: std.ArrayList(Phrase) = .empty;
    var inside = false;
    var segs = std.mem.splitScalar(u8, query, '"');
    var first = true;
    while (segs.next()) |seg| {
        if (!first) {
            if (inside) phrases.items[phrases.items.len - 1].closed = true;
            inside = !inside;
            if (inside) phrases.append(arena, .{ .first = tokens.items.len, .end = tokens.items.len, .closed = false, .terms = 0 }) catch return -c.SQLITE_NOMEM;
        }
        first = false;
        var it = std.mem.tokenizeAny(u8, seg, " \t\r\n\x0b\x0c");
        while (it.next()) |tok| {
            var terms: std.ArrayList([]const u8) = .empty;
            const rc = fold(h, arena, tok, &terms);
            if (rc != 0) return rc;
            const at: ?usize = if (inside) phrases.items.len - 1 else null;
            tokens.append(arena, .{ .raw = tok, .terms = terms.items, .phrase = at }) catch return -c.SQLITE_NOMEM;
            if (at) |i| {
                phrases.items[i].end = tokens.items.len;
                phrases.items[i].terms += terms.items.len;
            }
        }
    }
    // Only the last word can still be being typed, and not after a space.
    if (query.len != 0 and !std.ascii.isWhitespace(query[query.len - 1])) {
        var i = tokens.items.len;
        while (i > 0) : (i -= 1) {
            if (tokens.items[i - 1].terms.len != 0) {
                tokens.items[i - 1].prefix = true;
                break;
            }
        }
    }
    out.* = .{ .tokens = tokens.items, .phrases = phrases.items };
    return 0;
}

/// Appends `term` as a quoted FTS5 string, doubling `"` so the expression is
/// safe regardless of tokenizer.
fn appendQuoted(alloc: std.mem.Allocator, out: *std.ArrayList(u8), term: []const u8) !void {
    try out.append(alloc, '"');
    for (term) |ch| {
        if (ch == '"') try out.append(alloc, '"');
        try out.append(alloc, ch);
    }
    try out.append(alloc, '"');
}

fn appendAnd(alloc: std.mem.Allocator, out: *std.ArrayList(u8)) !void {
    if (out.items.len != 0) try out.appendSlice(alloc, " AND ");
}

/// Writes the MATCH expression for `s` into `out`: every term ANDed, the last
/// one typed matched as a start. `alts[i]`, when given and non-empty, ORs
/// token `i` with the typo ladder's near-misses. With `in_order`, a quoted run
/// of two or more terms must appear as written; a near-miss stands in for its
/// word there by the best one alone, since FTS5 has no OR inside a phrase.
pub fn emit(
    alloc: std.mem.Allocator,
    out: *std.ArrayList(u8),
    s: Scan,
    alts: ?[]const []const []const u8,
    in_order: bool,
) !void {
    out.clearRetainingCapacity();
    var i: usize = 0;
    while (i < s.tokens.len) {
        const t = s.tokens[i];
        if (in_order and t.phrase != null and s.phrases[t.phrase.?].terms >= 2) {
            const p = s.phrases[t.phrase.?];
            try appendAnd(alloc, out);
            // One string of folded terms: FTS5 reads it as the phrase.
            try out.append(alloc, '"');
            var n: usize = 0;
            var prefix = false;
            for (s.tokens[p.first..p.end], p.first..) |pt, k| {
                const best: ?[]const u8 = if (alts) |a| (if (a[k].len != 0) a[k][0] else null) else null;
                const words: []const []const u8 = if (best) |b| &.{b} else pt.terms;
                for (words) |w| {
                    if (n != 0) try out.append(alloc, ' ');
                    for (w) |ch| {
                        if (ch == '"') try out.append(alloc, '"');
                        try out.append(alloc, ch);
                    }
                    n += 1;
                }
                prefix = prefix or pt.prefix;
            }
            try out.append(alloc, '"');
            if (prefix and !p.closed) try out.append(alloc, '*');
            i = p.end;
            continue;
        }
        const near: []const []const u8 = if (alts) |a| a[i] else &.{};
        if (near.len == 0) {
            for (t.terms, 0..) |term, k| {
                try appendAnd(alloc, out);
                try appendQuoted(alloc, out, term);
                if (t.prefix and k + 1 == t.terms.len) try out.append(alloc, '*');
            }
        } else {
            // AND is explicit because FTS5 rejects `"a" ("b" OR "c")`.
            try appendAnd(alloc, out);
            try out.append(alloc, '(');
            try appendQuoted(alloc, out, t.terms[0]);
            if (t.prefix) try out.append(alloc, '*');
            for (near) |alt| {
                try out.appendSlice(alloc, " OR ");
                try appendQuoted(alloc, out, alt);
            }
            try out.append(alloc, ')');
        }
        i += 1;
    }
}
