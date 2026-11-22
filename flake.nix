{
  inputs.factory8.url = "git+https://github.com/factory8/factory8?ref=master";
  inputs.nixpkgs.follows = "factory8/nixpkgs";

  outputs = { factory8, nixpkgs, ... }:
    # The sandbox image holds claude-code, the one unfree package allowed.
    let pkgs = import nixpkgs {
      system = "x86_64-linux";
      config.allowUnfreePredicate = p: nixpkgs.lib.getName p == "claude-code";
    };
    superpowers = pkgs.fetchFromGitHub { # v7.0.2
      owner = "obra"; repo = "superpowers";
      rev = "22f0b463e7a5e579904dd6211a520321035526f7";
      hash = "sha256-rP5YsyGuPd9YSW/Fj3aukrq1bLuV+nwwQMK4JaZQgkI=";
    };
    in {
      packages.x86_64-linux.worker-image = factory8.lib.workerImage {
        inherit pkgs;
        name = "marketplace-worker";
        workflows = ./.factory8/workflows;
      };

      # The image factory8 runs this repo's agent steps in: shell.nix's tools plus the agent's.
      packages.x86_64-linux.sandbox-image = factory8.lib.sandboxImage {
        # Every step loads the superpowers skills. The package itself is wrapped: a separate `claude` script would
        # collide with claude-code's in the image's /bin. The name keeps getName = "claude-code" for the unfree predicate.
        pkgs = pkgs.extend (_: prev: {
          claude-code = prev.symlinkJoin {
            name = "claude-code-${prev.claude-code.version}";
            paths = [ prev.claude-code ];
            nativeBuildInputs = [ prev.makeWrapper ];
            postBuild = "wrapProgram $out/bin/claude --add-flags '--plugin-dir ${superpowers}'";
          };
        });
        name = "marketplace-sandbox";
        # shortcut: a shell keeps a multi-output package's dev output, which has no binaries (jq, curl), so its bin
        # output is added too; drop this once factory8's lib.sandboxImage does it itself.
        shell = let s = import ./shell.nix { inherit pkgs; };
          in s // { nativeBuildInputs = s.nativeBuildInputs ++ map (p: p.bin or p) s.nativeBuildInputs; };
      };
    };
}
