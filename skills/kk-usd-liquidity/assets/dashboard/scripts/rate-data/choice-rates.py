"""Fetch original four rate series through one serial Choice EDB session."""
import datetime as dt
import json
import os
from pathlib import Path
import sys
import time


def write(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, allow_nan=False, indent=2, default=str), encoding="utf-8")


def fetch_chunks(c, request, directory):
    results = []
    for index, chunk in enumerate(request["chunks"]):
        options = (f'StartDate={chunk["start"]},EndDate={chunk["end"]},'
                   'IsLatest=0,FixDate=0,Ispandas=0,RECVtimeout=120')
        for attempt in range(1, 4):
            result = c.edb(",".join(request["indicators"]), options)
            raw = {key: getattr(result, key, None) for key in
                   ("ErrorCode", "ErrorMsg", "Codes", "Indicators", "Dates", "Data")}
            evidence = {"request": {"function": "edb", "codes": request["indicators"], "options": options},
                        "fetchedAt": dt.datetime.now(dt.timezone.utc).isoformat(), "result": raw}
            write(directory / f"{index + 1:02d}-attempt-{attempt}.json", evidence)
            if result.ErrorCode == 0:
                break
            if attempt < 3:
                time.sleep(attempt)
        if result.ErrorCode != 0:
            raise RuntimeError(f'Choice EDB 第{index+1}段失败，错误码 {result.ErrorCode}')
        results.append({"start": chunk["start"], "end": chunk["end"], "result": raw})
        print(f'[choice-rates] 第{index+1}/{len(request["chunks"])}段已读取', flush=True)
    return results


def main():
    request_path, output_path = map(Path, sys.argv[1:3])
    request = json.loads(request_path.read_text(encoding="utf-8"))
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
    login = c.start("", lambda _: 1)
    if login.ErrorCode:
        raise RuntimeError(f"Choice EDB 登录失败，错误码 {login.ErrorCode}")
    try:
        write(output_path, {"chunks": fetch_chunks(c, request, output_path.parent)})
    finally:
        c.stop()


if __name__ == "__main__":
    main()
