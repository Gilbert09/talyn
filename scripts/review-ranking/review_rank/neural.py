"""Fit a shared queue model, then validate optional personal score adjustments."""

from collections import Counter

import numpy as np
from scipy.optimize import minimize

from .features import DAY, Choice
from .metrics import event_metrics, paired_interval


def layout(choices: list[Choice]) -> tuple:
    if not choices:
        raise ValueError("Training needs choices")
    sizes = np.asarray([len(choice.keys) for choice in choices])
    starts = np.r_[0, np.cumsum(sizes)[:-1]]
    selected = starts + np.asarray([choice.chosen for choice in choices])
    counts = Counter(choice.user for choice in choices)
    weights = np.asarray([1 / counts[choice.user] for choice in choices])
    return sizes, starts, selected, weights / weights.sum()


def choice_loss(scores: np.ndarray, groups: tuple) -> tuple[float, np.ndarray]:
    sizes, starts, selected, weights = groups
    maxima = np.maximum.reduceat(scores, starts)
    exp = np.exp(scores - np.repeat(maxima, sizes))
    sums = np.add.reduceat(exp, starts)
    loss = weights @ (maxima + np.log(sums) - scores[selected])
    derivative = exp / np.repeat(sums, sizes)
    derivative[selected] -= 1
    derivative *= np.repeat(weights, sizes)
    return float(loss), derivative


class SharedNetwork:
    def __init__(self, hidden: int = 16, regularization: float = 0.05, seed: int = 71):
        self.hidden = hidden
        self.regularization = regularization
        self.seed = seed

    def design(self, choices: list[Choice]) -> np.ndarray:
        result = []
        for choice in choices:
            z = np.clip((choice.x - self.mean) / self.scale, -8, 8)
            result.append(np.column_stack([z, np.tile(z.mean(axis=0), (len(z), 1))]))
        return np.vstack(result)

    def unpack(self, parameters: np.ndarray, width: int) -> tuple:
        end = width * self.hidden
        return (
            parameters[:end].reshape(width, self.hidden),
            parameters[end : end + self.hidden],
            parameters[end + self.hidden :],
        )

    def objective(self, parameters: np.ndarray, x: np.ndarray, groups: tuple) -> tuple:
        w, bias, out = self.unpack(parameters, x.shape[1])
        hidden = np.tanh(x @ w + bias)
        loss, ds = choice_loss(hidden @ out, groups)
        dh = ds[:, None] * out * (1 - hidden**2)
        gradient = np.r_[(x.T @ dh).ravel(), dh.sum(axis=0), hidden.T @ ds]
        return (
            loss + 0.5 * self.regularization * (parameters @ parameters),
            gradient + self.regularization * parameters,
        )

    def fit(self, choices: list[Choice]) -> "SharedNetwork":
        raw = np.vstack([choice.x for choice in choices])
        if not np.isfinite(raw).all():
            raise ValueError("Training features must be finite")
        self.mean = raw.mean(axis=0)
        self.scale = raw.std(axis=0)
        self.scale[self.scale < 1e-6] = 1
        x = self.design(choices)
        rng = np.random.default_rng(self.seed)
        initial = rng.normal(0, 0.05, x.shape[1] * self.hidden + 2 * self.hidden)
        result = minimize(
            self.objective,
            initial,
            args=(x, layout(choices)),
            jac=True,
            method="L-BFGS-B",
            options={"maxiter": 1000, "ftol": 1e-10},
        )
        if not result.success:
            raise RuntimeError(f"Shared network did not converge: {result.message}")
        self.parameters = result.x
        self.fit_info = {
            "converged": True,
            "iterations": result.nit,
            "parameters": len(result.x),
            "training_choices": len(choices),
        }
        return self

    def predict(self, choices: list[Choice]) -> list[np.ndarray]:
        if not choices:
            return []
        x = self.design(choices)
        w, bias, out = self.unpack(self.parameters, x.shape[1])
        scores = np.tanh(x @ w + bias) @ out
        return list(np.split(scores, np.cumsum([len(choice.keys) for choice in choices])[:-1]))


class PersonalAdjustments:
    """Freeze the shared scores. Unknown or unvalidated reviewers use them unchanged."""

    def __init__(self, shared, minimum_choices: int = 20, minimum_weeks: int = 2):
        self.shared = shared
        self.minimum_choices = minimum_choices
        self.minimum_weeks = minimum_weeks
        self.coefficients = {}
        self.enabled = set()
        self.validation = {}

    def fit(self, train: list[Choice]) -> "PersonalAdjustments":
        raw = np.vstack([choice.x for choice in train])
        self.mean = raw.mean(axis=0)
        self.scale = raw.std(axis=0)
        self.scale[self.scale < 1e-6] = 1
        self.train_end = max(choice.at for choice in train)
        self.coefficients.clear()
        self.enabled.clear()
        for user in sorted({choice.user for choice in train}):
            choices = [choice for choice in train if choice.user == user]
            if len(choices) < self.minimum_choices:
                continue
            x = np.clip(
                (np.vstack([choice.x for choice in choices]) - self.mean) / self.scale, -8, 8
            )
            offset = np.concatenate(self.shared.predict(choices))
            groups = layout(choices)

            def objective(w, offset=offset, x=x, groups=groups):
                loss, derivative = choice_loss(offset + x @ w, groups)
                return loss + 0.5 * (w @ w), x.T @ derivative + w

            result = minimize(objective, np.zeros(x.shape[1]), jac=True, method="L-BFGS-B")
            if not result.success:
                raise RuntimeError("Personal adjustment did not converge")
            self.coefficients[user] = result.x * len(choices) / (len(choices) + 50)
        return self

    def residual(self, choice: Choice) -> np.ndarray:
        w = self.coefficients.get(choice.user)
        if w is None:
            return np.zeros(len(choice.keys))
        return np.clip((choice.x - self.mean) / self.scale, -8, 8) @ w

    def validate(self, choices: list[Choice], order=None) -> dict:
        if not choices or min(choice.at for choice in choices) <= self.train_end:
            raise ValueError("Personal validation must follow training")
        self.enabled.clear()
        self.validation = {}

        def ordered(choice, scores):
            return scores if order is None else order(choice, scores)

        for user in sorted({choice.user for choice in choices}):
            subset = [choice for choice in choices if choice.user == user and len(choice.keys) > 3]
            enough = (
                user in self.coefficients
                and len(subset) >= self.minimum_choices
                and len({int(choice.at // (7 * DAY)) for choice in subset}) >= self.minimum_weeks
            )
            result = {"enabled": False, "choices": len(subset), "reason": "insufficient_history"}
            if enough:
                base = self.shared.predict(subset)
                deltas = np.asarray(
                    [
                        event_metrics(
                            ordered(choice, scores + self.residual(choice)), choice.chosen
                        )["hit3"]
                        - event_metrics(ordered(choice, scores), choice.chosen)["hit3"]
                        for choice, scores in zip(subset, base, strict=True)
                    ]
                )
                interval = paired_interval(subset, deltas)
                result.update(interval=interval, reason="no_positive_lower_bound")
                if interval["low"] > 0:
                    self.enabled.add(user)
                    result.update(enabled=True, reason="earlier_validation_gain")
            self.validation[user] = result
        self.validation_end = max(choice.at for choice in choices)
        return self.validation

    def predict(self, choices: list[Choice]) -> list[np.ndarray]:
        if (
            choices
            and hasattr(self, "validation_end")
            and min(c.at for c in choices) <= self.validation_end
        ):
            raise ValueError("Personal predictions must follow validation")
        return [
            scores + (self.residual(choice) if choice.user in self.enabled else 0)
            for choice, scores in zip(choices, self.shared.predict(choices), strict=True)
        ]
