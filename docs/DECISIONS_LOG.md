# Decision Log

Architectural and design decisions for the LibrePod marketplace. One row per
decision; keep each rationale to a sentence or two — this log records *what* and
*why*, not a full analysis (detail lives in code comments, troubleshooting docs,
or a dedicated write-up when a decision needs one).

Append-only: add a new dated row for each decision. If a decision is reversed,
mark the old row **Superseded by #N** and add the replacement — don't delete or
rewrite history.

| # | Date | Area | Decision | Rationale |
|---|------|------|----------|-----------|
| 1 | standing | packaging | Apps are packaged as OCI artifacts and deployed via FluxCD GitOps | Git-first, immutable, signed artifacts; cluster state is derived from git rather than mutated in place. |
| 2 | standing | networking | Apps expose HTTP through Traefik `IngressRoute`s; TLS is centralized in Traefik's default cert store — apps do not declare `tls:` blocks | One place for cert management; app manifests stay minimal. |
| 3 | standing | isolation | Each app creates and owns its namespace (named after the app) | Self-contained apps with a clear blast radius. |
| 4 | 2026-07-28 | cross-cutting | Host (NixOS) changes stay minimal or none; all app routing/NAT lives in the app + Kubernetes. The only exception is opening UDP 51820 on the host firewall (wg-easy is the device entrypoint) | Keeps the OS generic and makes every app portable across any device, NIC name, or network. |
| 5 | 2026-07-28 | wg-easy | Run without `hostNetwork`; expose on-LAN WireGuard UDP 51820 via a Traefik entryPoint; add a `sysctl` initContainer (`net.ipv4.ip_forward`, `net.ipv4.conf.all.src_valid_mark`) | Under `hostNetwork`, wg-easy's MASQUERADE landed on a wrong/guessed interface in a non-deterministic firewall backend (nftables vs legacy iptables), breaking NAT on some identical hosts. A pod netns always has `eth0`, so NAT is deterministic; routing through Traefik centralizes ingress and keeps the pod portable. Remote access uses the FRP relay → the wg-easy ClusterIP Service (no Traefik). |
