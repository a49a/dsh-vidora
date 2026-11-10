#!/usr/bin/env python3
"""Explicit, consent-gated model download for Vidora.

This is the only Vidora component allowed to access the network for weights.
The worker itself runs with HF_HUB_OFFLINE=1 and local_files_only=True.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

MODELS = {
    "qwen3-asr-0.6b": {
        "repo": "Qwen/Qwen3-ASR-0.6B",
        "directory": "Qwen3-ASR-0.6B",
        "approx_gb": 1.9,
        "license": "Apache-2.0",
    },
    "qwen3-asr-1.7b": {
        "repo": "Qwen/Qwen3-ASR-1.7B",
        "directory": "Qwen3-ASR-1.7B",
        "approx_gb": 4.7,
        "license": "Apache-2.0",
    },
    "qwen3-forced-aligner-0.6b": {
        "repo": "Qwen/Qwen3-ForcedAligner-0.6B",
        "directory": "Qwen3-ForcedAligner-0.6B",
        "approx_gb": 1.9,
        "license": "Apache-2.0",
    },
}


def main() -> int:
    parser = argparse.ArgumentParser(description="Download Vidora model weights after explicit consent")
    parser.add_argument("--model", action="append", required=True, help="Model id (repeatable)")
    parser.add_argument("--dest", required=True, help="Models directory")
    parser.add_argument("--endpoint", default=os.environ.get("HF_ENDPOINT", "https://huggingface.co"))
    parser.add_argument("--yes", action="store_true", help="Non-interactive confirmation")
    parser.add_argument("--revision", default=None)
    args = parser.parse_args()

    missing = [model for model in args.model if model not in MODELS]
    if missing:
        print(f"Unknown model(s): {', '.join(missing)}", file=sys.stderr)
        print(f"Known: {', '.join(MODELS)}", file=sys.stderr)
        return 2

    print("Vidora 模型下载计划")
    print(f"  来源:   {args.endpoint}")
    print(f"  目标:   {args.dest}")
    for model in args.model:
        item = MODELS[model]
        print(f"  - {model}: {item['repo']} (~{item['approx_gb']} GB, {item['license']})")
    print("")
    print("模型权重只会保存到上述目录；Worker 在离线模式下从本地目录加载。")
    if not args.yes:
        answer = input("确认下载？[y/N] ").strip().lower()
        if answer not in ("y", "yes"):
            print("已取消。")
            return 1

    os.environ["HF_ENDPOINT"] = args.endpoint
    os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
    try:
        from huggingface_hub import snapshot_download
    except Exception as exc:
        print(f"huggingface_hub is unavailable: {exc}", file=sys.stderr)
        return 3

    destination = Path(args.dest).expanduser().resolve()
    destination.mkdir(parents=True, exist_ok=True)
    manifest = {
        "schema_version": 1,
        "endpoint": args.endpoint,
        "downloaded_at": datetime.now(timezone.utc).isoformat(),
        "models": {},
    }
    manifest_path = destination / "manifest.json"
    if manifest_path.exists():
        try:
            previous = json.loads(manifest_path.read_text(encoding="utf-8"))
            if isinstance(previous.get("models"), dict):
                manifest["models"].update(previous["models"])
        except Exception:
            pass

    for model in args.model:
        item = MODELS[model]
        target = destination / item["directory"]
        print(f"\n下载 {item['repo']} -> {target}")
        target.mkdir(parents=True, exist_ok=True)
        kwargs = {
            "repo_id": item["repo"],
            "local_dir": str(target),
            "local_dir_use_symlinks": False,
        }
        if args.revision:
            kwargs["revision"] = args.revision
        try:
            snapshot_download(**kwargs)
        except TypeError:
            kwargs.pop("local_dir_use_symlinks", None)
            snapshot_download(**kwargs)
        files = []
        for root, _dirs, names in os.walk(target):
            for name in names:
                if name.startswith("."):
                    continue
                path = Path(root) / name
                try:
                    stat = path.stat()
                except OSError:
                    continue
                files.append({
                    "path": str(path.relative_to(target)),
                    "bytes": stat.st_size,
                })
        manifest["models"][model] = {
            "repo": item["repo"],
            "directory": item["directory"],
            "license": item["license"],
            "revision": args.revision,
            "files": sorted(files, key=lambda value: value["path"]),
        }
        print(f"完成：{model}（{len(files)} 个文件）")

    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"\n清单：{manifest_path}")
    print("Worker 将使用 HF_HUB_OFFLINE=1 从这些本地目录加载。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
