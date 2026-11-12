"""Read the existing ICE Brent EDB close series using one Choice API session."""

import datetime as dt
import json
import os
from pathlib import Path
import sys
import time

SERIES_ID = "EMM01588169"


def snapshot(result):
    return {key: getattr(result, key, None) for key in
            ("ErrorCode", "ErrorMsg", "Codes", "Indicators", "Dates", "Data")}


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, default=str, allow_nan=False, indent=2), encoding="utf-8")


def fetch_ranges(c, ranges, directory):
    """The caller owns the session; each range uses the same source and options."""
    if not isinstance(ranges, list) or not 1 <= len(ranges) <= 10:
        raise ValueError("布伦特查询分片数无效")
    results = []
    for index, window in enumerate(ranges, 1):
        start, end = window["start"], window["end"]
        if dt.date.fromisoformat(start) > dt.date.fromisoformat(end):
            raise ValueError("布伦特查询日期顺序错误")
        options = (f"StartDate={start},EndDate={end},IsLatest=0,FixDate=0,"
                   "Ispandas=0,RECVtimeout=120")
        for attempt in range(1, 4):
            result = c.edb(SERIES_ID, options)
            payload = {"request": {"fn": "edb", "args": [SERIES_ID, options]},
                       "fetchedAt": dt.datetime.now(dt.timezone.utc).isoformat(), "result": snapshot(result)}
            write_json(directory / f"range-{index:02d}-attempt-{attempt}.json", payload)
            if result.ErrorCode == 0:
                results.append(payload)
                break
            if attempt == 3:
                raise RuntimeError(f"Choice 布伦特 API 三次失败，错误码 {result.ErrorCode}")
            time.sleep(attempt)
    return {"source": "Choice.edb", "seriesId": SERIES_ID, "results": results}


def main():
    request_path, output_path = map(Path, sys.argv[1:])
    request = json.loads(request_path.read_text(encoding="utf-8"))
    if request.get("seriesId") != SERIES_ID:
        raise ValueError("布伦特源端指标不符")
    sdk_value = os.environ.get("EMQUANT_SDK_DIR", "").strip()
    if not sdk_value:
        raise RuntimeError("请先配置 EMQUANT_SDK_DIR")
    sdk = Path(sdk_value).expanduser().resolve()
    if not (sdk / "EmQuantAPI.py").is_file():
        raise RuntimeError("EMQUANT_SDK_DIR 中缺少 EmQuantAPI.py")
    sys.path.insert(0, str(sdk))
    from EmQuantAPI import c, UtilAccess
    if sys.platform == "win32":
        UtilAccess.GetLibraryPath = staticmethod(lambda: str(sdk / "libs/windows/EmQuantAPI_x64.dll"))
    started = False
    try:
        login = c.start("", lambda _: 1)
        if login.ErrorCode:
            raise RuntimeError(f"Choice 布伦特登录失败，错误码 {login.ErrorCode}")
        started = True
        write_json(output_path, fetch_ranges(c, request["ranges"], output_path.parent))
    except Exception as error:
        write_json(output_path.parent / "error.json", {"error": str(error),
                   "fetchedAt": dt.datetime.now(dt.timezone.utc).isoformat()})
        raise
    finally:
        if started:
            c.stop()


if __name__ == "__main__":
    main()
