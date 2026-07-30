#!/usr/bin/env python3
"""Render LibrePod marketplace app templates from metadata.yaml.

Extracts templates (source, release, secret, kustomization) from an app's
metadata.yaml and renders them with variable substitution and OCI tag override.

Requires: pyyaml (install via: pip install pyyaml, or nix-shell -p python3Packages.pyyaml)

Usage:
    python3 render-templates.py --app whoami --tag PR-42 --base-domain librepod.dev
    python3 render-templates.py --app vaultwarden --output-dir /tmp/verify-app
"""

import argparse
import os
import re
import secrets
import string
import sys

import yaml


def load_metadata(app_name, apps_dir="apps"):
    """Load and parse the app's metadata.yaml."""
    path = os.path.join(apps_dir, app_name, "metadata.yaml")
    if not os.path.exists(path):
        print(f"Error: metadata.yaml not found at {path}", file=sys.stderr)
        sys.exit(1)
    with open(path) as f:
        return yaml.safe_load(f)


def generate_secret_value(length=64):
    """Generate a random secret value."""
    alphabet = string.ascii_letters + string.digits
    return "".join(secrets.choice(alphabet) for _ in range(length))


def substitute_vars(template, variables):
    """Substitute ${VAR} patterns in the template string."""
    def replacer(match):
        var_name = match.group(1)
        return variables.get(var_name, match.group(0))
    return re.sub(r"\$\{(\w+)\}", replacer, template)


def replace_tag(source_template, tag):
    """Replace the OCI artifact tag in the source template."""
    return re.sub(r'(tag:\s*")[^"]*(")', rf"\g<1>{tag}\g<2>", source_template)


def render_app(app_name, tag, base_domain, output_dir, apps_dir="apps", metadata=None):
    """Render all templates for an app and write to output directory."""
    if metadata is None:
        metadata = load_metadata(app_name, apps_dir)
    spec = metadata.get("spec", {})
    templates = spec.get("templates", {})
    app_secrets = spec.get("secrets", [])

    # Build variable map
    variables = {"BASE_DOMAIN": base_domain}

    # Generate secret values with distinction between auto-generated and required
    for secret_def in app_secrets:
        name = secret_def["name"]
        gen = secret_def.get("generate", {})
        is_required = secret_def.get("required", False)

        if gen.get("type") == "random":
            variables[name] = generate_secret_value(gen.get("length", 64))
        else:
            # Generating a placeholder for a user-provided secret
            variables[name] = generate_secret_value()
            if is_required:
                print(f"  ⚠ Generated placeholder for required secret '{name}' "
                      f"(no generate.type specified — value is random for testing)",
                      file=sys.stderr)

    # Ensure output directory exists
    app_dir = os.path.join(output_dir, app_name)
    os.makedirs(app_dir, exist_ok=True)

    # Render each template
    rendered_files = []
    for tmpl_name, tmpl_content in templates.items():
        content = tmpl_content

        # Override OCI tag in the source template
        if tmpl_name == "source":
            content = replace_tag(content, tag)

        # Substitute variables
        content = substitute_vars(content, variables)

        filename = f"{tmpl_name}.yaml"
        filepath = os.path.join(app_dir, filename)
        with open(filepath, "w") as f:
            f.write(content)
        rendered_files.append(filename)
        print(f"  Rendered: {filename}")

    # Print generated secrets for reference
    if app_secrets:
        print(f"\n  Generated secrets:")
        for secret_def in app_secrets:
            name = secret_def["name"]
            val = variables[name]
            print(f"    {name}: {val[:8]}... ({len(val)} chars)")

    return rendered_files, variables


def main():
    parser = argparse.ArgumentParser(
        description="Render LibrePod marketplace app templates from metadata.yaml"
    )
    parser.add_argument(
        "--app", required=True, help="App name (e.g., whoami, vaultwarden)"
    )
    parser.add_argument(
        "--tag",
        help="OCI artifact tag (default: use version from metadata.yaml)",
    )
    parser.add_argument(
        "--base-domain",
        default="librepod.dev",
        help="Base domain for the cluster (default: librepod.dev)",
    )
    parser.add_argument(
        "--output-dir",
        default="/tmp/verify-app",
        help="Output directory (default: /tmp/verify-app)",
    )
    parser.add_argument(
        "--apps-dir",
        default="apps",
        help="Path to apps directory (default: apps)",
    )

    args = parser.parse_args()

    # Load metadata once (shared between tag resolution and rendering)
    metadata = load_metadata(args.app, args.apps_dir)

    # Determine tag
    if args.tag:
        tag = args.tag
    else:
        tag = metadata.get("spec", {}).get("version", "latest")

    print(f"Rendering app: {args.app}")
    print(f"  OCI tag: {tag}")
    print(f"  Base domain: {args.base_domain}")
    print(f"  Output: {os.path.join(args.output_dir, args.app)}")
    print()

    rendered, variables = render_app(
        args.app, tag, args.base_domain, args.output_dir, args.apps_dir,
        metadata=metadata
    )

    print(f"\nRendered {len(rendered)} files for {args.app}")


if __name__ == "__main__":
    main()
