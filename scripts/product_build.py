#!/usr/bin/env python3
"""Select, build and verify a complete Idle desktop product without intermediate releases."""

import argparse
from pathlib import Path

from product_pipeline import sources


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    plan = commands.add_parser("plan")
    plan.add_argument("--output", type=Path, required=True)
    plan.add_argument("--revisions", default="{}")
    plan.add_argument("--source-repository", default="")
    plan.add_argument("--source-revision", default="")
    checkout = commands.add_parser("checkout")
    checkout.add_argument("--plan", type=Path, required=True)
    checkout.add_argument("--directory", type=Path, required=True)
    checkout.add_argument("--repositories", nargs="+", choices=sources.REPOSITORIES, required=True)
    for name in ["build", "finish"]:
        command = commands.add_parser(name)
        command.add_argument("--plan", type=Path, required=True)
        command.add_argument("--sources", type=Path, required=True)
        command.add_argument("--output", type=Path, required=True)
    publish = commands.add_parser("publish")
    publish.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.command == "plan":
        sources.plan(args.output, args.revisions, args.source_repository, args.source_revision)
    elif args.command == "checkout":
        sources.checkout(sources.read(args.plan), args.directory, args.repositories)
    elif args.command == "build":
        from product_pipeline.build import build
        build(args.plan.resolve(), args.sources.resolve(), args.output.resolve())
    elif args.command == "finish":
        from product_pipeline.finish import finish
        finish(args.plan.resolve(), args.sources.resolve(), args.output.resolve())
    elif args.command == "publish":
        from product_pipeline.publish import publish
        publish(args.output.resolve())


if __name__ == "__main__":
    main()
