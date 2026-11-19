# services.inkhold: the server, and optionally its nightly backup and weekly
# deep check. The same units as contrib/systemd, written from Nix:
#
#   services.inkhold = {
#     enable = true;
#     openFirewall = true;
#     settings.host = "0.0.0.0";       # the tablet must reach it
#     backup.enable = true;
#     backup.directory = "/mnt/nas/inkhold";
#   };
#
# `journalctl -u inkhold` shows the first account's password, once.
{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.services.inkhold;
  inherit (lib)
    mkOption
    mkEnableOption
    mkIf
    types
    ;

  configFile = pkgs.writeText "inkhold-config.zon" (import ./zon.nix { inherit lib; } cfg.settings);
  inkhold = "${lib.getExe cfg.package} --config=${configFile}";
  stateDir = "/var/lib/inkhold";

  # The backup's own units: it reads the server's state as the server's account.
  backupService = description: exec: {
    inherit description;
    wants = [ "network-online.target" ];
    after = [ "network-online.target" ];
    unitConfig.RequiresMountsFor = [ cfg.backup.directory ];
    serviceConfig = exec // {
      Type = "oneshot";
      User = "inkhold";
      Group = "inkhold";
      # The backup lowers its own priority; these repeat it for whatever it starts.
      Nice = 19;
      IOSchedulingClass = "idle";
      CPUWeight = "idle";
    };
  };
  timer = description: calendar: {
    inherit description;
    wantedBy = [ "timers.target" ];
    timerConfig = {
      OnCalendar = calendar;
      RandomizedDelaySec = "15min";
      Persistent = true;
    };
  };
  dir = lib.escapeShellArg cfg.backup.directory;
in
{
  options.services.inkhold = {
    enable = mkEnableOption "Inkhold, a self-hosted server for Supernote tablets";

    package = mkOption {
      type = types.package;
      default = pkgs.callPackage ./package.nix { };
      defaultText = lib.literalExpression "pkgs.callPackage ./package.nix { }";
      description = "The Inkhold release to run.";
    };

    settings = mkOption {
      description = ''
        The server's config.zon, as Nix. Every setting is in the manual's
        "config.zon settings"; nested ones (`tls`, `history`) are attribute sets.
        The paths default into ${stateDir}, the only place the server may write.
      '';
      default = { };
      example = lib.literalExpression ''
        {
          host = "0.0.0.0";
          admin_email = "me@example.com";
          history.keep = 10;
        }
      '';
      type = types.submodule {
        freeformType = (pkgs.formats.json { }).type;
        options = {
          host = mkOption {
            type = types.str;
            default = "127.0.0.1";
            description = ''
              The address to listen on. The default accepts only this machine:
              the tablet and other browsers need "0.0.0.0" (or a reverse proxy).
            '';
          };
          port = mkOption {
            type = types.port;
            default = 8089;
            description = "The port to listen on.";
          };
          db_path = mkOption {
            type = types.str;
            default = "${stateDir}/inkhold.db";
            description = "The database.";
          };
          cred_key_path = mkOption {
            type = types.str;
            default = "${stateDir}/cred.key";
            description = ''
              The key that encrypts stored credentials, created on first start.
              Back it up apart from the server: without it, everyone resets
              their password after a restore.
            '';
          };
          data_dir = mkOption {
            type = types.str;
            default = "${stateDir}/data";
            description = "Notebooks, files and the search index.";
          };
          web_dir = mkOption {
            type = types.str;
            default = "${cfg.package}/share/inkhold/web";
            defaultText = lib.literalExpression ''"''${cfg.package}/share/inkhold/web"'';
            description = "The browser app; empty serves none.";
          };
        };
      };
    };

    openFirewall = mkOption {
      type = types.bool;
      default = false;
      description = "Open `settings.port` in the firewall.";
    };

    backup = {
      enable = mkEnableOption "a nightly backup: one snapshot, then a quick check of it";
      directory = mkOption {
        type = types.str;
        example = "/mnt/nas/inkhold";
        description = ''
          An existing folder the `inkhold` account can write, best on another
          disk (a NAS, USB, a synced cloud folder): a backup on the same disk
          goes down with it.
        '';
      };
      keep = mkOption {
        type = types.ints.positive;
        default = 7;
        description = "Snapshots kept; older ones are removed.";
      };
      includeCredKey = mkOption {
        type = types.bool;
        default = false;
        description = ''
          Put `cred.key` in each snapshot too, so a restore keeps everyone's
          password. Then the backup alone can read stored credentials.
        '';
      };
      calendar = mkOption {
        type = types.str;
        default = "*-*-* 03:00:00";
        description = "When it runs (systemd.time); a run missed while off runs at boot.";
      };
      deepCheck = {
        enable = mkEnableOption ''
          a weekly deep check of the backups: every file re-read against its
          name, every snapshot's database checked. On an "online-only" cloud
          folder it downloads the whole backup each week
        '';
        calendar = mkOption {
          type = types.str;
          default = "Sun *-*-* 04:00:00";
          description = "When it runs (systemd.time).";
        };
      };
    };
  };

  config = mkIf cfg.enable {
    assertions = [
      {
        assertion = cfg.backup.deepCheck.enable -> cfg.backup.enable;
        message = "services.inkhold.backup.deepCheck needs services.inkhold.backup.enable.";
      }
    ];

    users.users.inkhold = {
      isSystemUser = true;
      group = "inkhold";
      home = stateDir;
    };
    users.groups.inkhold = { };

    networking.firewall.allowedTCPPorts = mkIf cfg.openFirewall [ cfg.settings.port ];

    systemd.services.inkhold = {
      description = "Inkhold";
      wants = [ "network-online.target" ];
      after = [ "network-online.target" ];
      wantedBy = [ "multi-user.target" ];
      restartTriggers = [ configFile ];
      serviceConfig = {
        User = "inkhold";
        Group = "inkhold";
        ExecStart = inkhold;
        StateDirectory = "inkhold";
        StateDirectoryMode = "0700";
        WorkingDirectory = stateDir;
        Restart = "on-failure";
        RestartSec = 5;

        # Nothing but its own state is writable; nothing it does can gain privileges.
        NoNewPrivileges = true;
        ProtectSystem = "strict";
        ProtectHome = true;
        PrivateTmp = true;
        PrivateDevices = true;
        ProtectKernelTunables = true;
        ProtectKernelModules = true;
        ProtectControlGroups = true;
        RestrictSUIDSGID = true;
        LockPersonality = true;
      };
    };

    systemd.services.inkhold-backup = mkIf cfg.backup.enable (
      backupService "Inkhold backup" {
        ExecStart = "${inkhold} backup create ${dir} --keep=${toString cfg.backup.keep}${lib.optionalString cfg.backup.includeCredKey " --include-cred-key"}";
        ExecStartPost = "${inkhold} backup verify ${dir}";
      }
    );
    systemd.timers.inkhold-backup = mkIf cfg.backup.enable (
      timer "Nightly Inkhold backup" cfg.backup.calendar
    );

    systemd.services.inkhold-backup-verifier = mkIf cfg.backup.deepCheck.enable (
      backupService "Inkhold backup deep check" {
        ExecStart = "${inkhold} backup verify ${dir} --deep";
      }
    );
    systemd.timers.inkhold-backup-verifier = mkIf cfg.backup.deepCheck.enable (
      timer "Weekly Inkhold backup deep check" cfg.backup.deepCheck.calendar
    );
  };
}
