"""Local fresh-profile UI check. No login, credentials or external browser navigation."""
import json
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'evidence'
OUT.mkdir(exist_ok=True)
(OUT / 'screenshots').mkdir(exist_ok=True)
errors, external_requests = [], []
BASE = 'http://127.0.0.1:4317'

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    context = browser.new_context(viewport={'width': 1440, 'height': 1050}, accept_downloads=True)
    def route_local(route):
        if route.request.url.startswith(BASE + '/'):
            route.continue_()
        else:
            external_requests.append(route.request.url)
            route.abort()
    context.route('**/*', route_local)
    page = context.new_page()
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(BASE, wait_until='networkidle')
    expect(page.locator('#startButton')).to_be_enabled()
    assert 'MOCK' in page.locator('#mode-notice-title').inner_text()
    page.locator('#startButton').click()
    expect(page.locator('#runState')).to_have_text('已完成')
    snapshot = page.evaluate("fetch('/api/run').then(r => r.json())")
    expected = {'capacity': 24, 'registered': 36, 'waitlist': 12, 'time': '14:00–16:00', 'weatherBackup': '待确认'}
    assert all(snapshot['proposal'][k] == v for k, v in expected.items())
    assert snapshot['mode'] == 'MOCK' and snapshot['counters']['generationPosts'] == 0
    assert snapshot['counters']['maxConcurrentAgents'] >= 2
    assert snapshot['unresolved']
    assert page.locator('#attachmentRows .difference-tag').all_text_contents() == ['一致'] * 4
    with page.expect_download() as download_info:
        page.locator('#freezeButton').click()
    download_info.value.save_as(OUT / 'browser-frozen-mock.json')
    bundle = json.loads((OUT / 'browser-frozen-mock.json').read_text(encoding='utf-8'))
    assert bundle['snapshot']['artifactStatus'] == 'FROZEN' and bundle['runId'] == snapshot['runId']
    page.screenshot(path=str(OUT / 'screenshots' / 'desktop-mock.png'), full_page=True)
    page.set_viewport_size({'width': 390, 'height': 844})
    assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1')
    page.screenshot(path=str(OUT / 'screenshots' / 'mobile-mock.png'), full_page=True)
    page.set_viewport_size({'width': 1440, 'height': 1050})
    page.locator('#sampleSelect').select_option('community-no-change')
    expect(page.locator('#startButton')).to_be_enabled()
    page.locator('#startButton').click()
    expect(page.locator('#runState')).to_have_text('已完成')
    unchanged = page.evaluate("fetch('/api/run').then(r => r.json())")
    assert unchanged['proposal'] == unchanged['original'] and unchanged['proposalVersion'] == 0
    page.locator('#startButton').click()
    page.locator('#stopButton').click()
    expect(page.locator('#runState')).to_have_text('已停止')
    stopped = page.evaluate("fetch('/api/run').then(r => r.json())")
    assert stopped['status'] == 'STOPPED'
    assert not errors and not external_requests
    report = {'status': 'PASS', 'mode': 'MOCK', 'engine': 'Playwright Chromium fresh headless context',
              'viewportWidths': [1440, 390], 'sampleUpdateRunId': snapshot['runId'],
              'checks': ['source preview and mock label', 'UI start and completed revision', 'source-backed output values',
                         'zero real generation posts', 'downloaded frozen bundle', 'mobile horizontal overflow absent',
                         'no-change sample unchanged', 'UI stop', 'no page errors', 'no external page requests'],
              'pageErrors': errors, 'externalPageRequests': external_requests,
              'limitations': ['No live model calls', 'Not a human visual/usability acceptance', 'No external browser profile or authenticated dashboard used']}
    (OUT / 'browser-check.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(report, ensure_ascii=True))
    browser.close()
