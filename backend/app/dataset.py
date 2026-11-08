"""Dataset parsing. A dataset is the three input files; the app receives them as uploads from
the browser's folder picker, the scoring harness reads them from folders under data/."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any, BinaryIO

import numpy as np
import pandas as pd

REQUIRED_FILES: tuple[str, ...] = ("network.json", "ops.json", "telemetry.csv")

# Where the scoring harness looks for answer-keyed folders: repo-root `data/` unless overridden.
DATA_DIR: Path = Path(
    os.environ.get("DATA_DIR", Path(__file__).resolve().parents[2] / "data")
).resolve()


def discover_datasets(root: Path = DATA_DIR) -> dict[str, Path]:
    """Map dataset name (folder path relative to root) to folder, for every folder with all three files."""
    found: dict[str, Path] = {}
    for network_file in sorted(root.rglob("network.json")):
        folder: Path = network_file.parent
        if all((folder / name).is_file() for name in REQUIRED_FILES):
            found[folder.relative_to(root).as_posix()] = folder
    return found


@dataclass(frozen=True)
class Well:
    id: str
    baseline_water_bpd: float
    oil_bpd: float
    gas_mcfd: float


@dataclass(frozen=True)
class Facility:
    """One facility's asset IDs and the reference values its detectors compare against."""

    id: str
    system_id: str
    tank_id: str
    pump_id: str
    pipeline_id: str
    wells: tuple[Well, ...]
    capacity_bbl: float
    max_flow_bpd: float
    disposal_psi: float


@dataclass(frozen=True)
class Dataset:
    name: str
    network: dict[str, Any]
    ops: dict[str, Any]
    facilities: list[Facility]
    ts: np.ndarray  # int64 unix seconds, ascending, one per 5-minute step
    frame: pd.DataFrame  # index ts_unix, columns (asset_id, metric)

    @property
    def now_unix(self) -> int:
        return int(self.ts[-1])

    def row(self, unix: int) -> int:
        """Row index of an exact timestamp on the 5-minute grid."""
        return int(np.searchsorted(self.ts, unix))

    def series(self, asset_id: str, metric: str) -> np.ndarray:
        return self.frame[(asset_id, metric)].to_numpy(dtype=float)


def build_facilities(network: dict[str, Any]) -> list[Facility]:
    """Walk network.json once; never parse IDs to infer topology."""
    facilities: list[Facility] = []
    for system in network["systems"]:
        disposal_psi: float = float(system["disposal_site"]["pressure_psi"])
        for fac in system["facilities"]:
            facilities.append(
                Facility(
                    id=fac["id"],
                    system_id=system["id"],
                    tank_id=fac["tank"]["id"],
                    pump_id=fac["pump"]["id"],
                    pipeline_id=fac["pipeline"]["id"],
                    wells=tuple(
                        Well(
                            id=w["id"],
                            baseline_water_bpd=float(w["baseline_water_bpd"]),
                            oil_bpd=float(w["oil_bpd"]),
                            gas_mcfd=float(w["gas_mcfd"]),
                        )
                        for w in fac["wells"]
                    ),
                    capacity_bbl=float(fac["tank"]["capacity_bbl"]),
                    max_flow_bpd=float(fac["pump"]["max_flow_bpd"]),
                    disposal_psi=disposal_psi,
                )
            )
    return facilities


TELEMETRY_COLUMNS: tuple[str, ...] = ("ts_unix", "asset_id", "metric", "value")


def load_dataset(name: str, folder: Path, now_unix: int | None = None) -> Dataset:
    """Load a dataset folder from disk (used by the scoring harness)."""
    return parse_dataset(
        name,
        (folder / "network.json").read_bytes(),
        (folder / "ops.json").read_bytes(),
        folder / "telemetry.csv",
        now_unix,
    )


def parse_dataset(
    name: str,
    network_json: bytes,
    ops_json: bytes,
    telemetry_csv: Path | BinaryIO,
    now_unix: int | None = None,
) -> Dataset:
    """Build a Dataset from the three files' contents; `now_unix` truncates the telemetry so every
    result is computed as of that moment. Raises ValueError on malformed input."""
    try:
        network: dict[str, Any] = json.loads(network_json)
        ops: dict[str, Any] = json.loads(ops_json)
    except json.JSONDecodeError as err:
        raise ValueError(f"{name}: invalid JSON: {err}") from err
    try:
        long: pd.DataFrame = pd.read_csv(
            telemetry_csv,
            dtype={"ts_unix": "int64", "asset_id": "string", "metric": "string", "value": "float64"},
        )
    except ValueError as err:
        raise ValueError(f"{name}: telemetry.csv could not be parsed: {err}") from err
    missing: set[str] = set(TELEMETRY_COLUMNS) - set(long.columns)
    if missing:
        raise ValueError(f"{name}: telemetry.csv is missing columns {sorted(missing)}")
    frame: pd.DataFrame = long.pivot(index="ts_unix", columns=["asset_id", "metric"], values="value").sort_index()
    if frame.empty:
        raise ValueError(f"{name}: telemetry.csv has no rows")
    try:
        facilities: list[Facility] = build_facilities(network)
    except (KeyError, TypeError) as err:
        raise ValueError(f"{name}: network.json does not have the expected systems/facilities layout ({err})") from err
    dataset: Dataset = Dataset(
        name=name,
        network=network,
        ops=ops,
        facilities=facilities,
        ts=frame.index.to_numpy(dtype=np.int64),
        frame=frame,
    )
    return dataset if now_unix is None else truncate(dataset, now_unix)


def truncate(ds: Dataset, now_unix: int) -> Dataset:
    """The dataset as an operator saw it at `now_unix`: every row after it dropped."""
    frame: pd.DataFrame = ds.frame.loc[ds.frame.index <= now_unix]
    if frame.empty:
        raise ValueError(f"{ds.name}: no telemetry at or before {now_unix}")
    return replace(ds, ts=frame.index.to_numpy(dtype=np.int64), frame=frame)
