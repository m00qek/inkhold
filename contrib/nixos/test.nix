# Three VMs on one network. `server` runs the module with the firewall open,
# and its backup and deep check; `closed` is the same server with the
# firewall left shut; `client` is the tablet's side of the network.
{ pkgs, module }:

let
  inkhold = {
    imports = [ module ];
    services.inkhold = {
      enable = true;
      settings.host = "0.0.0.0";
    };
  };
in
pkgs.testers.runNixOSTest {
  name = "inkhold";

  nodes = {
    server = {
      imports = [ inkhold ];
      services.inkhold = {
        openFirewall = true;
        settings.history.keep = 3;
        backup = {
          enable = true;
          directory = "/backup";
          includeCredKey = true;
          deepCheck.enable = true;
        };
      };
      systemd.tmpfiles.rules = [ "d /backup 0700 inkhold inkhold -" ];
    };
    closed = inkhold;
    client.environment.systemPackages = [ pkgs.curl ];
  };

  testScript = ''
    start_all()

    with subtest("the server starts and prints the first password"):
        server.wait_for_unit("inkhold.service")
        server.wait_for_open_port(8089)
        server.wait_until_succeeds("journalctl -u inkhold | grep -qi password")

    with subtest("the browser app is served across the network"):
        client.wait_for_unit("multi-user.target")
        client.succeed("curl -sf --max-time 10 http://server:8089/ | grep -qi '<html'")

    with subtest("without openFirewall, the port is shut to the network"):
        closed.wait_for_unit("inkhold.service")
        closed.wait_for_open_port(8089)
        client.fail("curl -sf --max-time 5 http://closed:8089/")

    with subtest("both backup timers are scheduled"):
        server.succeed("systemctl list-timers | grep -q inkhold-backup.timer")
        server.succeed("systemctl list-timers | grep -q inkhold-backup-verifier.timer")

    with subtest("a backup holds a snapshot, with cred.key"):
        server.succeed("systemctl start inkhold-backup.service")
        server.succeed("cmp /var/lib/inkhold/cred.key /backup/*Z/cred.key")

    with subtest("the deep check passes, and the server is still up"):
        server.succeed("systemctl start inkhold-backup-verifier.service")
        server.succeed("systemctl is-active inkhold.service")
  '';
}
