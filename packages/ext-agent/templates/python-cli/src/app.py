"""{{projectName}} — a tiny Python CLI scaffolded by Sunday."""

import argparse


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="{{projectName}}", description="Say hello.")
    parser.add_argument("name", nargs="?", default="world", help="who to greet")
    parser.add_argument("--shout", action="store_true", help="uppercase the greeting")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    greeting = f"Hello, {args.name}!"
    print(greeting.upper() if args.shout else greeting)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
