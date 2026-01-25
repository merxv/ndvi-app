# train_automl.py
from __future__ import annotations

import argparse
import os

from bns_model import load_bns_long_csv, train_automl_model


def parse_args() -> argparse.Namespace:
    base_dir = os.path.dirname(os.path.abspath(__file__))
    parser = argparse.ArgumentParser(description="Train AutoGluon baseline model for BNS data.")
    parser.add_argument(
        "--data",
        default=os.getenv("BNS_LONG_CSV", os.path.join(base_dir, "data", "bns_yield_2004_2024_long.csv")),
        help="Path to BNS long CSV (district, year, yield_c_per_ha)",
    )
    parser.add_argument(
        "--save-path",
        default=os.getenv("AUTOML_MODEL_PATH", os.path.join(base_dir, "autogluon_bns_model")),
        help="Directory to save AutoGluon model",
    )
    parser.add_argument(
        "--presets",
        default="medium_quality",
        help="AutoGluon presets (e.g., medium_quality)",
    )
    parser.add_argument(
        "--time-limit",
        type=float,
        default=None,
        help="Time limit in seconds for AutoGluon training",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    bns_df = load_bns_long_csv(args.data)
    train_automl_model(
        bns_df=bns_df,
        save_path=args.save_path,
        presets=args.presets,
        time_limit=args.time_limit,
    )


if __name__ == "__main__":
    main()
