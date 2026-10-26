import pytest
from cs2demos.hltv import Hltv, PageBudgetExhausted, demo_path_from_html


def test_demo_path_from_html():
    html_with_href = '<a href="/download/demo/12345" class="stream-box">Demo</a>'
    assert demo_path_from_html(html_with_href) == "/download/demo/12345"

    html_with_data_attr = '<div data-demo-link="/download/demo/67890">Download</div>'
    assert demo_path_from_html(html_with_data_attr) == "/download/demo/67890"

    html_without_link = '<div class="no-demo">No demo available</div>'
    assert demo_path_from_html(html_without_link) is None


def test_page_budget_exhausted(tmp_path):
    hltv = Hltv(max_pages=1, profile=tmp_path / "profile", cache=tmp_path / "cache")
    hltv.pages_used = 1
    with pytest.raises(PageBudgetExhausted):
        hltv._wait_turn()
