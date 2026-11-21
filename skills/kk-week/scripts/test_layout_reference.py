from html.parser import HTMLParser
from pathlib import Path
import re
import unittest


class Layout(HTMLParser):
    def __init__(self, text):
        super().__init__()
        self.panels, self.tabs, self.navs, self.anchors = [], [], [], []
        self.ids, self.frames, self.external = set(), [], []
        self.feed(text)

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        for key, values in [('data-report-panel', self.panels), ('data-report', self.tabs), ('data-report-nav', self.navs)]:
            if key in attrs:
                values.append(attrs[key])
        if 'id' in attrs:
            self.ids.add(attrs['id'])
        if tag == 'iframe':
            self.frames.append(tag)
        href = attrs.get('href') or ''
        if tag == 'a' and href.startswith('#'):
            self.anchors.append(href[1:])
        for key in ('src', 'href'):
            address = attrs.get(key) or ''
            if address.startswith(('https:', 'http:', '//', 'file:')):
                self.external.append(address)


class LayoutTests(unittest.TestCase):
    def test_five_pages_share_one_offline_document(self):
        text = (Path(__file__).resolve().parents[1] / 'templates/weekly-layout.html').read_text(encoding='utf-8')
        order = ['macro', 'hk', 'sectors', 'strategy', 'usd']
        doc = Layout(text)
        self.assertEqual(doc.tabs, order)
        self.assertEqual(doc.navs, order)
        self.assertEqual(doc.panels, order)
        self.assertFalse(doc.frames)
        self.assertFalse(doc.external)
        self.assertFalse(set(doc.anchors) - doc.ids)
        self.assertNotRegex(text, re.compile(r'\b20\d{2}(?:-\d{2}-\d{2}|W\d{2})\b'))
        self.assertIn('版式示例', text)
