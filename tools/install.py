"""Copy this extension's runtime files into a SillyTavern user directory."""

import argparse
from pathlib import Path
import shutil


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sillytavern", type=Path, required=True)
    parser.add_argument("--user", default="default-user")
    args = parser.parse_args()
    root = args.sillytavern.resolve(strict=True)
    if not (root / "public" / "script.js").is_file():
        parser.error("The target is not a SillyTavern checkout.")
    if not args.user or Path(args.user).name != args.user or args.user in (".", ".."):
        parser.error("--user must be one directory name.")
    source = Path(__file__).resolve().parents[1]
    user_root = (root / "data" / args.user).resolve(strict=True)
    if not user_root.is_relative_to((root / "data").resolve(strict=True)):
        parser.error("The user directory escapes SillyTavern data.")
    target = (user_root / "extensions" / "st-context-helper").resolve()
    if not target.is_relative_to(user_root):
        parser.error("The extension directory escapes the selected user.")
    target.mkdir(parents=True, exist_ok=True)
    for name in ("index.js", "manifest.json", "style.css", "README.md", "LICENSE"):
        path = source / name
        if path.is_file():
            shutil.copy2(path, target / name)
    shutil.copytree(source / "src", target / "src", dirs_exist_ok=True)
    print(f"Installed Context Helper into {target}")
    print("Refresh SillyTavern to load this version.")


if __name__ == "__main__":
    main()
