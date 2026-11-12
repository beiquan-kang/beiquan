"""Synthetic fixtures only; run: python -B -m unittest discover -s scripts -v."""
import datetime as dt
import importlib.util
from pathlib import Path
import unittest

PATH = Path(__file__).with_name('week_report.py')
if PATH.exists():
    spec = importlib.util.spec_from_file_location('week_report', PATH)
    wr = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(wr)
else:
    wr = None


class DisplayRegressionTests(unittest.TestCase):
    def test_layout_summary_pp_and_mean_completeness(self):
        data=fixture()
        data['summary']={'headline':'周报结论','market':'市场说明','flows':'资金说明','rates':'利率说明'}
        data['indicators']['div']=metric([('2026-10-30',3.5),('2026-11-05',3.3)],kind='pp',unit='%')
        data['earnings']=[{'name':'恒生科技','rows':[{'date':'2026-10-30','value':-1},{'date':'2026-11-05','value':-2}]}]
        page=wr.render(data)
        self.assertIn('-0.20pp',page)
        self.assertIn('本周速读',page)
        self.assertIn('中国股票指数2027年盈利预期修正',page)
        self.assertIn('-1.00pp',page)
        self.assertLess(page.index('市场说明'),page.index('<section'))
        self.assertLess(page.index('<svg'),page.index('class="changes"'))
        self.assertIn('截至',page)
        item=metric([('2026-11-05',100)],aggregation='mean')
        self.assertIsNone(wr.period_value(item,'2026-11-02','2026-11-05',data['calendar']))

class WeekTests(unittest.TestCase):
    def test_week_boundaries_and_timezone(self):
        self.assertTrue(callable(getattr(wr, 'prepare', None)), 'prepare is not implemented')
        for day, monday, sunday, week in [
            ('2027-01-02', '2026-12-28', '2027-01-03', '2026-W53'),
            ('2027-01-03', '2026-12-28', '2027-01-03', '2026-W53'),
            ('2027-01-04', '2026-12-28', '2027-01-03', '2026-W53'),
            ('2027-01-08', '2026-12-28', '2027-01-03', '2026-W53'),
            ('2027-01-09', '2027-01-04', '2027-01-10', '2027-W01')]:
            result = wr.prepare('.', day)
            self.assertEqual((result['mon'], result['sun'], result['week']), (monday, sunday, week))
            self.assertEqual(dt.date.fromisoformat(result['friday']).weekday(), 4)
            self.assertIsNotNone(dt.datetime.fromisoformat(result['generated_at']).tzinfo)


def fixture():
    calendar = ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30',
                '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05']
    return {'week': '2026-W45', 'market_end': '2026-11-05', 'previous_close': '2026-10-30',
            'calendar': calendar, 'indicators': {}, 'earnings': [], 'summary': {}}


def metric(rows, kind='absolute', aggregation='last', frequency='daily', name='测试', unit='亿元'):
    return dict(name=name, unit=unit, frequency=frequency, change_kind=kind,
                aggregation=aggregation, source='synthetic-only',
                rows=[{'date': d, 'value': v} for d, v in rows])


class CalculationTests(unittest.TestCase):
    def test_period_changes_and_complete_sums(self):
        self.assertTrue(callable(getattr(wr, 'calculate', None)), 'calculate is not implemented')
        data = fixture()
        data['indicators'] = {
            'hsi': metric([('2026-10-30', 100), ('2026-11-05', 110)], 'pct'),
            'ust': metric([('2026-10-30', 4.0), ('2026-11-05', 4.2)], 'pp', unit='%'),
            'south': metric([(d, 2) for d in data['calendar']], aggregation='sum'),
            'foreign': metric([('2026-10-30', 3)], aggregation='sum'),
            'pmi': metric([('2026-08-31', 48), ('2026-09-30', 49), ('2026-10-31', 51)],
                          kind='pp', frequency='monthly'),
            'credit': metric([('2026-10-30', 10), ('2026-11-03', 15)], frequency='weekly'),
        }
        result = wr.calculate(data)
        self.assertAlmostEqual(result['indicators']['hsi']['change'], 10)
        self.assertAlmostEqual(result['indicators']['ust']['change'], .2)
        self.assertEqual(result['indicators']['south']['value'], 8)
        self.assertEqual(result['indicators']['south']['change'], -2)
        self.assertIsNone(result['indicators']['foreign']['value'])
        self.assertEqual(result['indicators']['pmi']['change'], 2)
        self.assertEqual(result['indicators']['credit']['change'], 5)
        data['indicators']['hsi']['rows'] = [{'date': '2026-10-23', 'value': 50},
                                             {'date': '2026-11-05', 'value': 110}]
        self.assertIsNone(wr.calculate(data)['indicators']['hsi']['change'])
        data['indicators']['hsi']['rows'] = [{'date': '2026-10-30', 'value': 100}]
        self.assertIsNone(wr.calculate(data)['indicators']['hsi']['value'])
        data['indicators']['south']['rows'].pop()
        self.assertIsNone(wr.calculate(data)['indicators']['south']['value'])


    def test_derived_series_use_same_day_and_complete_gross(self):
        data = fixture()
        days = data['calendar']
        data['indicators'] = {
            'ust': metric([(days[-2], 4), (days[-1], 4.2)], 'pp', unit='%'),
            'cgb': metric([(days[-2], 2), (days[-1], None)], 'pp', unit='%'),
            'south_gross': metric([(d, 20) for d in days], aggregation='sum'),
            'turnover': metric([(d, 100) for d in days], aggregation='sum'),
        }
        items = wr.calculate(data)['indicators']
        self.assertIn('share', items)
        self.assertEqual(items['share']['value'], 10)
        self.assertEqual(wr.row_map(items['spread'])[days[-2]], -2)
        self.assertIsNone(wr.row_map(items['spread'])[days[-1]])
        self.assertAlmostEqual(wr.row_map(items['weighted'])[days[-2]], 3.8)
        self.assertIsNone(wr.row_map(items['weighted'])[days[-1]])
        data['indicators']['south_gross']['rows'].pop()
        items = wr.calculate(data)['indicators']
        self.assertIsNone(items['share']['value'])
        self.assertIsNone(wr.row_map(items['weighted'])[days[-2]])

    def test_reject_invalid_inputs(self):
        data = fixture()
        data['market_end'] = '2026-11-06'
        with self.assertRaises(ValueError):
            wr.calculate(data)
        data = fixture()
        data['indicators']['hsi'] = metric([('2026-11-05', float('nan'))])
        with self.assertRaises(ValueError):
            wr.calculate(data)
        data['indicators']['hsi'] = metric([('2026-11-05', 1), ('2026-11-05', 2)])
        with self.assertRaises(ValueError):
            wr.calculate(data)


class RenderTests(unittest.TestCase):
    def test_html_structure_escaping_empty_state_and_gap_paths(self):
        self.assertTrue(callable(getattr(wr, 'render', None)), 'render is not implemented')
        data = fixture()
        data['summary'] = {'headline': '<img src=x onerror=alert(1)>', 'market': '测试<&文本'}
        data['indicators']['hsi'] = metric([('2026-10-30', 100), ('2026-11-02', 101),
                                           ('2026-11-03', None), ('2026-11-04', 103),
                                           ('2026-11-05', 104)], 'pct', name='<unsafe>')
        data['indicators']['hscei'] = metric([('2026-10-30', 200), ('2026-11-02', 204),
                                             ('2026-11-04', 206), ('2026-11-05', 208)], 'pct')
        data['earnings'] = [{'name': '盈利<甲>', 'source': 'HIDDEN-SOURCE',
                             'rows': [{'date': '2026-10-30', 'value': -5},
                                      {'date': '2026-11-05', 'value': 10}]}]
        page = wr.render(data)
        self.assertEqual(page.count('<article '), 21)
        self.assertEqual(page.count('<svg '), 21)
        self.assertEqual(page.count('class="chart-dates"'), 21)
        self.assertEqual(page.count('<section '), 5)
        self.assertIn('id="earnings" class="chart wide"', page)
        self.assertIn('&lt;img src=x onerror=alert(1)&gt;', page)
        self.assertNotIn('<img ', page)
        self.assertNotIn('HIDDEN-SOURCE', page)
        self.assertNotIn('synthetic-only', page)
        self.assertIn('暂无数据', page)
        self.assertIn('IntersectionObserver', page)
        self.assertIn('position:sticky', page)
        self.assertIn('@media', page)
        self.assertIn('viewBox="0 0 1000 ', page)
        self.assertNotIn('max-height', page)
        series = wr.chart_series(data['indicators']['hsi'], data['calendar'], '2026-10-30', '2026-11-05')
        svg = wr.svg_chart([('one', series)], '%')
        import re
        path = re.search(r'<path class="series"[^>]* d="([^"]*)"', svg).group(1)
        self.assertEqual(path.count('M'), 2)
        self.assertEqual(series[0][1], 100)
        self.assertIn(('2026-11-03', None), series)

    def test_missing_month_week_and_exact_week_base(self):
        data = fixture()
        data['indicators']['pmi'] = metric([('2026-08-31', 48), ('2026-10-31', 51),
                                           ('2026-11-30', 90)], frequency='monthly')
        data['indicators']['credit'] = metric([('2026-10-23', 5), ('2026-11-03', 9)], frequency='weekly')
        result = wr.calculate(data)['indicators']
        self.assertEqual(result['pmi']['value'], 51)
        self.assertIsNone(result['pmi']['change'])
        self.assertIsNone(result['credit']['change'])
        self.assertTrue(any(v is None for _, v in wr.chart_series(data['indicators']['credit'],
                        data['calendar'], '2026-10-23', '2026-11-05')))
        data['indicators']['hsi'] = metric([('2026-11-02', 101), ('2026-11-05', 104)], 'pct')
        page = wr.render(data)
        article = page.split('<article id="week-prices"', 1)[1].split('</article>', 1)[0]
        self.assertIn('暂无数据', article)
        self.assertNotIn('class="series"', article)

    def test_required_metadata_and_yield_units(self):
        data = fixture()
        data['indicators']['ust'] = metric([('2026-11-05', 4)], 'pp', unit='%')
        del data['indicators']['ust']['frequency']
        with self.assertRaises(ValueError):
            wr.calculate(data)
        data['indicators']['ust'] = metric([('2026-11-05', 4)], 'pp', unit='decimal')
        data['indicators']['cgb'] = metric([('2026-11-05', 2)], 'pp', unit='%')
        with self.assertRaises(ValueError):
            wr.calculate(data)

    def test_strict_week_format_and_missing_observation_breaks(self):
        with self.assertRaises(ValueError):
            wr.week_dates('2026-W5')
        data = fixture()
        data['week'] = '2026-W5'
        with self.assertRaises(ValueError):
            wr.calculate(data)
        data = fixture()
        data['indicators']['hsi'] = metric([('2026-10-30', 0), ('2026-11-05', 10)], 'pct')
        self.assertIsNone(wr.calculate(data)['indicators']['hsi']['change'])
        item = metric([('2026-11-02', 10), ('2026-11-04', 20)])
        series = wr.chart_series(item, data['calendar'], '2026-11-02', '2026-11-05')
        self.assertIn(('2026-11-03', None), series)
        self.assertIn(('2026-11-05', None), series)
        data['indicators']['hsi'] = metric([('2026-10-30', 10), ('2026-11-04', 11),
                                           ('2026-11-05', None)], 'pct')
        self.assertIsNone(wr.calculate(data)['indicators']['hsi']['value'])

    def test_cli_prepare_render_without_persistent_artifacts(self):
        import json
        import subprocess
        import tempfile
        import sys
        import os
        prepared = subprocess.run([sys.executable, '-B', str(PATH), 'prepare', '--project', '.',
                                   '--as-of', '2027-01-04'], capture_output=True, text=True, check=True)
        self.assertEqual(json.loads(prepared.stdout)['week'], '2026-W53')
        with tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR')) as directory:
            source = Path(directory) / 'normalized.json'
            target = Path(directory) / 'report.html'
            source.write_text(json.dumps(fixture()), encoding='utf-8')
            completed = subprocess.run([sys.executable, '-B', str(PATH), 'render', '--data', str(source),
                                        '--out', str(target)], capture_output=True, text=True, check=True)
            self.assertEqual(target.read_text(encoding='utf-8').count('<article '), 21)
            self.assertIn('report.html', completed.stdout)


if __name__ == '__main__':
    unittest.main()
