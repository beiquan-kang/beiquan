"""合并四个已完成数据验收的周报页面，标准库，无联网副作用。"""
import argparse
import json
import re
from html.parser import HTMLParser
from pathlib import Path

ORDER = [('macro', '宏观'), ('hk', '港股'), ('sectors', 'A股板块复盘'), ('strategy', 'A股策略')]

class Panels(HTMLParser):
    def __init__(self, text):
        super().__init__(convert_charrefs=False)
        self.text = text
        self.lines = [0]
        for m in re.finditer('\n', text): self.lines.append(m.end())
        self.depth = 0
        self.start = None
        self.key = None
        self.parts = {}
    def position_offset(self):
        line, col = self.getpos()
        return self.lines[line - 1] + col
    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if self.start is not None and tag == self.key[0]: self.depth += 1
        if self.start is None and (a.get('data-report-panel') or a.get('data-report-nav')):
            kind = 'panel' if a.get('data-report-panel') else 'nav'
            self.key = (tag, kind, a.get('data-report-panel') or a.get('data-report-nav'))
            self.start = self.position_offset()
            self.depth = 1
    def handle_endtag(self, tag):
        if self.start is not None and tag == self.key[0]:
            self.depth -= 1
            if not self.depth:
                end = self.text.index('>', self.position_offset()) + 1
                self.parts[(self.key[1], self.key[2])] = self.text[self.start:end]
                self.start = None
    def handle_startendtag(self, tag, attrs): pass

def compose(shell, inputs=None):
    parsed = Panels(shell); parsed.feed(shell)
    parts = parsed.parts
    if inputs:
        for key, source in inputs.items():
            p = Panels(source); p.feed(source)
            for kind in ['panel', 'nav']:
                if (kind, key) not in p.parts: raise ValueError(f'{key}缺少{kind}')
                parts[(kind, key)] = p.parts[(kind, key)]
    for kind in ['panel', 'nav']:
        for key, _ in ORDER:
            if (kind, key) not in parts: raise ValueError(f'缺少{key}/{kind}')
    buttons = ''.join(f'<button data-report="{k}" role="tab">{n}</button>' for k, n in ORDER)
    shell, n = re.subn(r'(<div\b[^>]*class="report-tabs"[^>]*>).*?(</div>)', lambda m:m[1]+buttons+m[2], shell, count=1, flags=re.S)
    if n != 1: raise ValueError('缺少报告切换栏')
    # 原位替换四组panel/nav，保持其他结构及数据脚本不变。
    p = Panels(shell); p.feed(shell)
    for kind in ['panel', 'nav']:
        positions = [(shell.index(raw), raw) for (t, key), raw in p.parts.items() if t == kind]
        if len(positions) != 4: raise ValueError(f'{kind}数量须为4')
        positions.sort()
        for (_, raw), (key, _) in zip(positions, ORDER):
            new = parts[(kind, key)]
            new = re.sub(r'\s+hidden(?:="[^"]*")?', '', new, count=1)
            # 初始显示由脚本统一设置；无JS时全部可见。
            marker = f'<!--REPORT_{kind}_{key}-->'
            shell = shell.replace(raw, marker, 1)
        for key, _ in ORDER: shell = shell.replace(f'<!--REPORT_{kind}_{key}-->', re.sub(r'\s+hidden(?:="[^"]*")?', '', parts[(kind,key)], count=1), 1)
    # 无锚点的默认页为宏观，其余页深链继续保留。
    shell = shell.replace("activate(location.hash.startsWith", "activate(location.hash.startsWith")
    shell = shell.replace("?'macro':'hk',false)", "?'macro':location.hash.startsWith('#hk-')?'hk':'macro',false)")
    shell = shell.replace("?'macro':'hk';activate(name,false)", "?'macro':location.hash.startsWith('#hk-')?'hk':'macro';activate(name,false)")
    return shell

def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--shell', required=True, help='已经验收的四合一HTML')
    ap.add_argument('--out', required=True)
    ap.add_argument('--inputs', help='JSON：macro/hk/sectors/strategy对应HTML路径；含各自panel与nav')
    a = ap.parse_args()
    shell = Path(a.shell).read_text(encoding='utf-8')
    inputs = None
    if a.inputs:
        mapping = json.loads(Path(a.inputs).read_text(encoding='utf-8'))
        if set(mapping) != {k for k,_ in ORDER}: raise ValueError('inputs必须完整提供四页')
        inputs = {k:Path(v).read_text(encoding='utf-8') for k,v in mapping.items()}
    text = compose(shell, inputs)
    out = Path(a.out); out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(text, encoding='utf-8')
    print(json.dumps({'output':str(out),'order':[n for _,n in ORDER]}, ensure_ascii=False))
if __name__ == '__main__': main()
