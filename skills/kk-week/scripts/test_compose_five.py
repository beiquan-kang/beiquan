import unittest
from html.parser import HTMLParser

class Page(HTMLParser):
    def __init__(self, text):
        super().__init__(); self.frames=[]; self.labels=[]; self.feed(text)
    def handle_starttag(self, tag, attrs):
        attrs=dict(attrs)
        if tag=='iframe': self.frames.append(attrs)
        if 'data-report' in attrs: self.labels.append(attrs['data-report'])

class FiveTests(unittest.TestCase):
    def test_five_complete_and_frames_preserve_scope(self):
        from compose_five import compose, ORDER
        pages={key:f'<figure id="shared">{label} &amp; W47</figure>' for key,label in reversed(ORDER)}
        doc=Page(compose('2026-W47', pages))
        self.assertEqual(doc.labels, [key for key,_ in ORDER]); self.assertEqual(len(doc.frames),5)
        for (key,label),f in zip(ORDER,doc.frames):
            self.assertEqual(f['title'],label); self.assertIn(pages[key],f['srcdoc']); self.assertNotIn('src',f)

    def test_reject_missing_and_empty(self):
        from compose_five import compose, ORDER
        pages={key:'<p>content</p>' for key,_ in ORDER}
        with self.assertRaises(ValueError): compose('2026-W47',{k:v for k,v in pages.items() if k!='usd'})
        with self.assertRaises(ValueError): compose('2026-W47',dict(pages,usd=' '))
        with self.assertRaises(ValueError): compose('2026-W99',pages)

    def test_preserve_standalone_document(self):
        from compose_five import compose, ORDER
        text='<!doctype html><html><head><style>p{color:red}</style></head><body><p>content</p></body></html>'
        doc=Page(compose('2026-W47',{key:text for key,_ in ORDER}))
        self.assertTrue(all(f['srcdoc']==text for f in doc.frames))
