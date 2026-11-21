"""合并同一交易周的五份已验收页面，不发起取数。"""
import argparse
from datetime import date
from html import escape
import json
from pathlib import Path
import re

ORDER = [('macro','宏观'),('hk','港股'),('sectors','A股板块复盘'),('strategy','A股策略'),('usd','美元流动性')]


def compose(week, pages):
    if not re.fullmatch(r'\d{4}-W\d{2}', week):
        raise ValueError('周格式须为 YYYY-Www')
    monday = date.fromisocalendar(int(week[:4]), int(week[6:]), 1)
    friday = date.fromisocalendar(int(week[:4]), int(week[6:]), 5)
    if set(pages) != {k for k,_ in ORDER}:
        raise ValueError('须同时提供宏观、港股、A股板块复盘、A股策略、美元流动性')
    buttons=[]; frames=[]
    for key,label in ORDER:
        text=pages[key].strip()
        if not text:
            raise ValueError(f'{label}内容为空')
        if not re.match(r'^(?:<!doctype\s+html\b|<html\b)',text,re.I):
            text='<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;padding:12px;box-sizing:border-box;font-family:Arial,KaiTi,STKaiti,serif;background:#efefef;color:#2b414f}*,*::before,*::after{box-sizing:border-box}img,svg{max-width:100%}</style></head><body>'+text+'</body></html>'
        buttons.append(f'<a id="tab-{key}" data-report="{key}" href="#{key}">{label}</a>')
        frames.append(f'<section id="{key}" aria-labelledby="tab-{key}"><iframe title="{label}" sandbox="allow-scripts allow-downloads allow-popups" srcdoc="{escape(text,quote=True)}"></iframe></section>')
    return f'''<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>综合投研周报 · {week}</title><style>
:root{{font-family:Arial,KaiTi,STKaiti,serif;color:#2b414f;background:#efefef}}body{{margin:0}}header{{background:#fff;padding:.65rem 1rem;border-bottom:2px solid #5e9dca}}h1{{margin:0;font-size:1.5rem}}.period{{margin:.32rem 0}}nav{{display:flex;gap:.35rem;flex-wrap:wrap}}nav a{{color:#346d94;text-decoration:none;padding:.35rem .55rem;border-radius:.3rem;white-space:nowrap}}nav a[aria-current=true]{{background:#e1e7eb;box-shadow:inset 0 -2px #ce695a}}section iframe{{display:block;width:100%;height:calc(100vh - 8rem);height:calc(100dvh - 8rem);min-height:240px;border:0}}section[hidden]{{display:none}}</style></head><body>
<header><h1>综合投研周报 · {week}</h1><p class="period">交易周：{monday} 至 {friday}</p><nav aria-label="周报栏目">{''.join(buttons)}</nav></header><main>{''.join(frames)}</main><script>
(()=>{{const tabs=[...document.querySelectorAll('[data-report]')];function show(){{const hash=location.hash.slice(1);const k=tabs.map(t=>t.dataset.report).find(x=>hash===x||hash.startsWith(x+'-'))||'macro';for(const t of tabs){{const key=t.dataset.report;document.getElementById(key).hidden=key!==k;if(key===k)t.setAttribute('aria-current','true');else t.removeAttribute('aria-current')}}}}window.addEventListener('hashchange',show);show()}})();</script></body></html>'''


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--week',required=True)
    parser.add_argument('--inputs',required=True,help='五页 HTML 路径的 JSON 对象，相对路径按该 JSON 文件所在目录解析')
    parser.add_argument('--out',required=True)
    args=parser.parse_args()
    src=Path(args.inputs).resolve()
    pages={k:(src.parent/v).read_text(encoding='utf-8-sig') for k,v in json.loads(src.read_text(encoding='utf-8-sig')).items()}
    output=Path(args.out).resolve()
    text=compose(args.week, pages)
    with output.open('x',encoding='utf-8',newline='\n') as f:
        f.write(text)
    print(json.dumps({'output':str(output),'week':args.week,'panels':list(dict(ORDER))},ensure_ascii=True))

if __name__=='__main__': main()
