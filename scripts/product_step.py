#!/usr/bin/env python3
"""Run a build command and append its elapsed time, including failed attempts."""

import argparse
from pathlib import Path
import subprocess

from product_pipeline.records import Timings


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--record", type=Path, required=True)
    parser.add_argument("--name", required=True)
    parser.add_argument("arguments", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.arguments[1:] if args.arguments[:1] == ["--"] else args.arguments
    if not command:
        parser.error("a command is required")
    with Timings(args.record).step(args.name):
        subprocess.run(command, check=True)


if __name__ == "__main__":
    main()
