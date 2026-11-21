{
  inputs.factory8.url = "git+https://github.com/factory8/factory8?ref=master";
  inputs.nixpkgs.follows = "factory8/nixpkgs";

  outputs = { factory8, nixpkgs, ... }:
    # The sandbox image holds claude-code, the one unfree package allowed.
    let pkgs = import nixpkgs {
      system = "x86_64-linux";
      config.allowUnfreePredicate = p: nixpkgs.lib.getName p == "claude-code";
    };
    in {
      packages.x86_64-linux.worker-image = factory8.lib.workerImage {
        inherit pkgs;
        name = "marketplace-worker";
        workflows = ./.factory8/workflows;
      };

      # The image factory8 runs this repo's agent steps in: shell.nix's tools plus the agent's.
      packages.x86_64-linux.sandbox-image = factory8.lib.sandboxImage {
        inherit pkgs;
        name = "marketplace-sandbox";
        # shortcut: a shell keeps a multi-output package's dev output, which has no binaries (jq, curl), so its bin
        # output is added too; drop this once factory8's lib.sandboxImage does it itself.
        shell = let s = import ./shell.nix { inherit pkgs; };
          in s // { nativeBuildInputs = s.nativeBuildInputs ++ map (p: p.bin or p) s.nativeBuildInputs; };
      };
    };
}
