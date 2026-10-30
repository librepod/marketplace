# headscale

## Public access

headscale's `server_url`, the headplane `public_url` and the OIDC redirect all
use `https://${PUBLIC_HOST}`. headscale does not care how it is exposed:
whichever exposure component (group `exposure`) is picked at install supplies
`PUBLIC_HOST`. Without one, they fall back to the local
`headscale.${BASE_DOMAIN}`, so only devices that already reach this LibrePod
(home network or VPN) can join.

## DERP and STUN

The embedded DERP region also advertises a STUN endpoint on UDP 3478 at the
same public hostname, and this app deliberately does NOT tunnel it.

Tunnelling STUN does work in the narrow sense — clients get a reply — but a
reverse tunnel that does not preserve client source addresses makes the reply
tell the client its public address is the tunnel client's own private address.
With derp.urls empty (see base/config.yaml) that is the client's ONLY STUN
result, so it becomes its GlobalV4: an address no peer can use. Hole-punching
then has no public endpoint to work with and traffic that could have gone
direct gets relayed instead. The measured latency is the whole tunnel loop,
too, rather than one hop to the edge.

So UDP 3478 belongs on the host that terminates the public hostname, where the
reply carries the client's real address. Nothing in this app can do that for
you; it is one service on the edge host. With tailscale's own binary (a
separate `derper` output in nixpkgs, no tailscaled required):

```
derper -c <statedir>/derper.key -derp=false -stun -stun-port=3478 \
       -http-port=-1 -a=<PUBLIC_IP>:7480
```

-a pins the UDP bind to one address, which matters for the same reason it
matters in base/deployment.yaml: a wildcard-bound UDP socket answers from a
route-selected source. A non-443 port on -a means plain HTTP and no ACME, so
there is no certificate to manage; firewall that port.

The DERP relay leg itself (TCP 443, through the exposure component) stays
tunnelled; only STUN moves to the edge.
