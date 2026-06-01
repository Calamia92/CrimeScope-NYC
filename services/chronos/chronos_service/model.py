from __future__ import annotations

from dataclasses import dataclass

import torch
from chronos import BaseChronosPipeline


@dataclass(frozen=True)
class ForecastBands:
    """Quantile bands for a multi-step forecast.

    Lengths of all three lists equal the forecast horizon.
    """

    median: list[float]
    lower: list[float]
    upper: list[float]


class ChronosForecaster:
    """Wraps an Amazon Chronos pipeline for univariate point forecasts with
    quantile bands.

    Defaults to chronos-2, Amazon's 120M-parameter encoder-only foundation
    model (Oct 2025). Override via the CHRONOS_MODEL env var, e.g.
    amazon/chronos-bolt-tiny / -small / -base for lighter footprints.
    """

    def __init__(
        self,
        model_name: str,
        quantile_low: float = 0.1,
        quantile_high: float = 0.9,
    ) -> None:
        self._model_name = model_name
        self._quantiles = [quantile_low, 0.5, quantile_high]
        # float32 keeps inference numerically stable on any CPU; the speedup
        # from bfloat16 only materializes on hardware with AVX512-BF16.
        self._pipeline = BaseChronosPipeline.from_pretrained(
            model_name,
            device_map="cpu",
            dtype=torch.float32,
        )

    @property
    def model_name(self) -> str:
        return self._model_name

    def forecast(self, history: list[float], horizon: int) -> ForecastBands:
        if len(history) < 1:
            raise ValueError("history must contain at least one point")
        if horizon < 1:
            raise ValueError("horizon must be >= 1")

        # Chronos-2 expects shape (n_series, n_variates, history_length); the
        # Bolt family accepts a flat 1-D tensor. (1, 1, T) is accepted by both.
        context = torch.tensor(history, dtype=torch.float32).reshape(1, 1, -1)
        with torch.inference_mode():
            quantiles, _mean = self._pipeline.predict_quantiles(
                inputs=context,
                prediction_length=horizon,
                quantile_levels=self._quantiles,
            )

        # Shape normalization across pipeline variants:
        #  - Chronos-Bolt returns a Tensor of shape (batch, prediction_length, n_quantiles)
        #  - Chronos-2 returns a list of Tensors of shape (n_variates, prediction_length, n_quantiles)
        head = quantiles[0]
        if head.dim() == 3:
            head = head[0]
        q = head.cpu().numpy()
        # Counts can't be negative; clamp lower bound to 0.
        lower = [max(float(v), 0.0) for v in q[:, 0]]
        median = [max(float(v), 0.0) for v in q[:, 1]]
        upper = [max(float(v), 0.0) for v in q[:, 2]]
        return ForecastBands(median=median, lower=lower, upper=upper)
