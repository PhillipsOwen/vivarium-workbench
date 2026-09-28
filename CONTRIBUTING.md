# Contributing

## Running the test suite

A minimal install runs most of the suite; some tests need optional readers or a
sibling checkout and **skip cleanly** (via `pytest.importorskip`) when those are
absent.

### 1. Base install

```bash
uv venv
uv pip install -e ".[dev]"
uv run pytest
```

### 2. Optional run-store readers (parquet / zarr)

Tests that exercise the parquet/zarr run-store paths need `polars`, `xarray`
(+ `zarr`), and `pyarrow`. They **skip** without them. To run them, add the
`test` extra:

```bash
uv pip install -e ".[dev,test]"
```

> Note: zarr run-store reading is normally exercised with the **v2ecoli** venv,
> which ships `xarray`/`zarr`; the dashboard's own venv intentionally omits them.
>
> Known issue (separate from test setup): with current `polars` (1.41.x) three
> `tests/test_study_charts_parquet.py` array-column tests fail because
> `study_charts._extract_paths_from_parquet` returns empty — a polars-version
> incompatibility tracked separately, not a missing-dependency problem.

### 3. Investigation / study tests — editable `pbg-superpowers`

A group of tests exercises the investigation/study orchestration that lives in
[`pbg-superpowers`](https://github.com/vivarium-collective/pbg-superpowers)
(`study_io`, `run_registry`, `investigation_status`, `readout_validation`,
`feedback_actions`, `resolve_run_expected`, `resolve_seed_source`,
`needs_attention`, …). The version pinned in the lockfile predates those
symbols, so these tests need an **editable install of a current local
checkout**:

```bash
# from a sibling checkout of pbg-superpowers on a current branch
uv pip install -e ../pbg-superpowers --no-deps
```

Without it, those tests fail at import or assert against the older behaviour.
This is the same editable-install convention the dashboard already uses for
local `pbg-superpowers` development.

### Full suite

```bash
uv pip install -e ".[dev,test]"
uv pip install -e ../pbg-superpowers --no-deps   # current local checkout
uv run pytest
```

## Installing from a bare clone, and the v2ecoli environment

The root project installs with a plain `uv sync` from a clone that has **nothing
beside it** — no sibling checkouts. CI's `standalone` workflow enforces that
(`uv sync --locked`, then `vwb smoke`); run the same check locally with
`scripts/standalone_smoke.sh`. Do not add `path = "../<sibling>"` sources to the
root `pyproject.toml`.

The e-coli environment that used to be the root's `demo` extra
(`uv sync --extra demo`) is its own project, with `v2ecoli` and `pbg-ptools` as
editable sibling checkouts:

```bash
# layout: <dir>/vivarium-workbench, <dir>/v2ecoli, <dir>/pbg-ptools
cd demos/v2ecoli && uv sync
```
