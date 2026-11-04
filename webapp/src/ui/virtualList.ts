// A windowed list: only the rows near the viewport exist in the DOM, recycled as
// the user scrolls, so a long listing costs a screen of nodes.

import { el } from "./dom";

export interface VirtualListOptions {
  scrollContainer: HTMLElement;
  hostContainer: HTMLElement;
  contentContainer: HTMLElement;
  totalItems: number;
  itemHeight: number;
  renderItem: (index: number) => HTMLElement;
  recycleItem?: (index: number, element: HTMLElement) => void;
  /** Number of viewports to overscan. Default 1 (one viewport above, one below). */
  overscan?: number;
}

export class VirtualList {
  private scrollContainer: HTMLElement;
  private hostContainer: HTMLElement;
  private contentContainer: HTMLElement;
  private spacer: HTMLElement;
  private totalItems: number;
  private itemHeight: number;
  private renderItem: (index: number) => HTMLElement;
  private recycleItem?: (index: number, element: HTMLElement) => void;
  private overscan: number;
  
  private renderedItems = new Map<number, HTMLElement>();
  private scrollHandler: () => void;
  private lastScrollTop = -1;
  private lastClientHeight = -1;


  constructor(opts: VirtualListOptions) {
    this.scrollContainer = opts.scrollContainer;
    this.hostContainer = opts.hostContainer;
    this.contentContainer = opts.contentContainer;
    this.totalItems = opts.totalItems;
    this.itemHeight = opts.itemHeight;
    this.renderItem = opts.renderItem;
    this.recycleItem = opts.recycleItem;
    this.overscan = opts.overscan ?? 1;

    this.hostContainer.style.position = "relative";

    this.spacer = el("div");
    this.spacer.style.width = "1px";
    this.spacer.style.height = `${this.totalItems * this.itemHeight}px`;

    this.contentContainer.style.position = "absolute";
    this.contentContainer.style.top = "0";
    this.contentContainer.style.left = "0";
    this.contentContainer.style.right = "0";

    this.hostContainer.replaceChildren(this.spacer, this.contentContainer);

    this.scrollHandler = () => this.render();
    this.scrollContainer.addEventListener("scroll", this.scrollHandler, { passive: true });
    
    this.render();
  }

  public render() {
    const scrollRect = this.scrollContainer.getBoundingClientRect();
    const hostRect = this.hostContainer.getBoundingClientRect();
    const scrollTop = Math.max(0, scrollRect.top - hostRect.top);
    const clientHeight = Math.min(scrollRect.height || 1000, window.innerHeight * 1.5);

    if (Math.abs(scrollTop - this.lastScrollTop) < 5 && this.lastClientHeight === clientHeight) {
      return;
    }
    this.lastScrollTop = scrollTop;
    this.lastClientHeight = clientHeight;

    const visibleStartIndex = Math.floor(scrollTop / this.itemHeight);
    const visibleEndIndex = Math.floor((scrollTop + clientHeight) / this.itemHeight);

    const visibleCount = Math.max(1, visibleEndIndex - visibleStartIndex + 1);
    const buffer = visibleCount * this.overscan;

    const startIndex = Math.max(0, visibleStartIndex - buffer);
    const endIndex = Math.min(this.totalItems - 1, visibleEndIndex + buffer);

    const newIndices = new Set<number>();
    for (let i = startIndex; i <= endIndex; i++) {
      newIndices.add(i);
    }

    for (const [index, element] of this.renderedItems.entries()) {
      if (!newIndices.has(index)) {
        this.recycleItem?.(index, element);
        element.remove();
        this.renderedItems.delete(index);
      }
    }

    for (const index of newIndices) {
      if (!this.renderedItems.has(index)) {
        const itemEl = this.renderItem(index);
        itemEl.style.position = "absolute";
        itemEl.style.top = `${index * this.itemHeight}px`;
        itemEl.style.left = "0";
        itemEl.style.right = "0";
        this.contentContainer.append(itemEl);
        this.renderedItems.set(index, itemEl);
      }
    }
  }

  public update(totalItems: number) {
    if (this.totalItems === totalItems) return;
    this.totalItems = totalItems;
    this.spacer.style.height = `${this.totalItems * this.itemHeight}px`;
    this.lastScrollTop = -1; // force render
    this.render();
  }


  /**
   * Re-measure and re-render unconditionally, e.g. after the container is
   * revealed (a hidden element measures 0×0) or resized without a scroll.
   */
  public refresh() {
    // Both guards must reset: an offset still at 0 is within the 5px slack.
    this.lastScrollTop = -1;
    this.lastClientHeight = -1;
    this.render();
  }

  public getRenderedItem(index: number): HTMLElement | undefined {
    return this.renderedItems.get(index);
  }

  public getRenderedItems(): IterableIterator<[number, HTMLElement]> {
    return this.renderedItems.entries();
  }

  public scrollIntoView(index: number) {
    const itemTop = index * this.itemHeight;
    const itemBottom = itemTop + this.itemHeight;
    
    // Current scroll position relative to the host container.
    const scrollRect = this.scrollContainer.getBoundingClientRect();
    const hostRect = this.hostContainer.getBoundingClientRect();
    const currentScrollTop = scrollRect.top - hostRect.top;
    
    if (itemTop < currentScrollTop) {
      this.scrollContainer.scrollTop += (itemTop - currentScrollTop);
    } else if (itemBottom > currentScrollTop + scrollRect.height) {
      this.scrollContainer.scrollTop += (itemBottom - (currentScrollTop + scrollRect.height));
    }
  }

  public destroy() {
    this.scrollContainer.removeEventListener("scroll", this.scrollHandler);
    for (const [index, element] of this.renderedItems.entries()) {
      this.recycleItem?.(index, element);
      element.remove();
    }
    this.renderedItems.clear();
    this.contentContainer.replaceChildren();
    this.hostContainer.replaceChildren();
  }
}
