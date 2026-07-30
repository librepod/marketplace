{ pkgs ? import <nixpkgs> {}}:

pkgs.mkShell {
  packages = [
    pkgs.fluxcd
    pkgs.just
    pkgs.k3d
    pkgs.go
    pkgs.kustomize
    pkgs.kubernetes-helm
  ];
}
