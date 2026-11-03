import math

import pytest

from app.services.metrics import channel_metrics, consistency_ratio, safe_ratio


def test_metrics_match_demonstration():
    values = [12000, 18000, 24000, 36000, 44000, 52000, 288000, 72000]
    metrics = channel_metrics([{"view_count": value} for value in values])
    assert metrics.count == 8
    assert metrics.median_views == 40000
    assert metrics.mean_views == 68250
    assert metrics.spike_ratio == 7.2
    assert metrics.consistency == .75
    expected_std = math.sqrt(sum((value - 68250) ** 2 for value in values) / 8)
    assert metrics.std_views == pytest.approx(expected_std)
    assert metrics.cv == pytest.approx(expected_std / 68250)


def test_unknown_views_are_not_zero_and_negative_is_not_observed():
    metrics = channel_metrics([{"view_count": None}, {"view_count": -1}, {"view_count": 0}])
    assert metrics.count == 1
    assert metrics.median_views == 0
    assert metrics.std_views == 0
    assert metrics.spike_ratio is None
    assert metrics.cv is None
    assert metrics.consistency == 1


def test_empty_metrics_all_undefined():
    metrics = channel_metrics([])
    assert metrics.count == 0
    for name, value in vars(metrics).items():
        if name != "count":
            assert value is None


@pytest.mark.parametrize("numerator,denominator,result", [(0, 1, 0), (2, 1, 2), (0, 0, None), (None, 1, None), (1, None, None), (1, 0, None), (-1, 1, None), (1, -1, None)])
def test_safe_ratio(numerator, denominator, result):
    assert safe_ratio(numerator, denominator) == result


def test_consistency_at_zero_median_is_defined():
    assert consistency_ratio([0, 0, 5], 0) == 1
    assert consistency_ratio([], 0) is None
