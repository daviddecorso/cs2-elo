import pytest
from cs2demos.hltv import Hltv, PageBudgetExhausted, demo_path_from_html, is_server_error


def test_server_error_page_is_not_a_match_page(tmp_path):
    error = "<html><head><title>hltv.org | 520: Web server is returning an unknown error</title>"
    assert is_server_error(error)
    assert not is_server_error("<title>Falcons vs. M80 at CS Asia Championships 2026 | HLTV.org</title>")

    hltv = Hltv(max_pages=0, profile=tmp_path / "profile", cache=tmp_path / "cache")
    (tmp_path / "cache").mkdir()
    (tmp_path / "cache" / "match-1.html").write_text(error)
    with pytest.raises(PageBudgetExhausted):
        hltv.match_page(1)


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
