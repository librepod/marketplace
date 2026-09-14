# sing-box router activation kit

Routes your wg-easy clients' traffic server-side: stay connected to your single
LibrePod WireGuard tunnel and let sing-box decide per-flow where traffic exits
(geoip / geosite / DNS / SNI rules) — e.g. censored services via an upstream
VPN exit, everything else (including your home cluster services) direct.

## Activate

1. Copy this directory (`wg-easy-router/`) into your cluster's **user-apps repo**
   (the private Gogs repo the marketplace installs apps into), next to the
   existing app directories.
2. Add it to the repo root `kustomization.yaml`:

   ```yaml
   resources:
     - wg-easy-router/
   ```

3. Edit `secret.yaml`:
   - replace the WireGuard `private_key` / peer `public_key` / peer `address`
     with your upstream VPN exit credentials;
   - adjust `domain_suffix` to your cluster's base domain (default `.libre.pod`);
   - adjust routing rules to taste (sing-box config reference linked in
     `secret.yaml`).
4. Validate the config before applying (an invalid config makes the sing-box
   sidecar crash-loop and takes wg-easy down with it):

   ```sh
   sing-box check -c config.json
   ```

5. Wait for Flux to apply (~1 min), then restart wg-easy to pick up the secret:

   ```sh
   kubectl -n wg-easy delete pod -l app.kubernetes.io/name=wg-easy
   ```

Verify activation:

```sh
kubectl -n wg-easy logs deploy/wg-easy -c router-init   # "rules applied"
kubectl -n wg-easy exec deploy/wg-easy -c wg-easy -- ip rule   # fwmark 0x1 lookup 100
```

## Deactivate

Remove the directory (and its entry from the root kustomization.yaml), then
delete the leftover secret and restart:

```sh
kubectl -n wg-easy delete secret sing-box-router
kubectl -n wg-easy delete pod -l app.kubernetes.io/name=wg-easy
```

## Notes

- The tproxy inbound must keep `listen_port: 12345` and the DNS inbound
  `5353` — the router-init rules hardcode them.
- Nested tunnels (your client → wg-easy → upstream exit) reduce effective MTU;
  the example pins the exit to 1280. If large transfers stall, lower the
  interface MTU wg-easy hands to clients (wg-easy UI → settings).
- If sing-box crashes while active, client traffic blackholes until it
  restarts (usually seconds). `kubectl -n wg-easy logs deploy/wg-easy -c sing-box`
  is the first stop when the VPN "is down but connected".
