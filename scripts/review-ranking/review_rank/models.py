"""Fit pooled rankers on complete choice groups."""

from collections import Counter
from dataclasses import dataclass

import numpy as np
from catboost import CatBoostRanker, Pool
from lightgbm import LGBMRanker
from scipy.optimize import minimize
from scipy.sparse import csr_matrix, hstack

from .features import Choice


@dataclass(frozen=True)
class Spec:
    family: str
    regularization: float = 0.01
    depth: int = 3
    iterations: int = 150
    personal: bool = False

    @property
    def name(self) -> str:
        if self.family == "logit":
            mode = "personal" if self.personal else "pooled"
            return f"{mode}-logit-l2-{self.regularization}"
        return f"{self.family}-depth-{self.depth}-trees-{self.iterations}"


SPECS = (
    Spec("logit", regularization=0.001),
    Spec("logit", regularization=0.01),
    Spec("logit", regularization=0.001, personal=True),
    Spec("logit", regularization=0.01, personal=True),
    Spec("lightgbm", depth=2),
    Spec("lightgbm", depth=3),
    Spec("lightgbm", depth=3, iterations=300),
    Spec("catboost", depth=3),
    Spec("catboost", depth=4),
)


def flatten(choices: list[Choice], columns: np.ndarray) -> tuple:
    if not choices:
        raise ValueError("Training needs choices")
    sizes = np.asarray([len(choice.keys) for choice in choices])
    starts = np.r_[0, np.cumsum(sizes)[:-1]]
    x = np.vstack([choice.x[:, columns] for choice in choices])
    y = np.zeros(len(x))
    y[starts + np.asarray([choice.chosen for choice in choices])] = 1
    users = Counter(choice.user for choice in choices)
    weights = np.asarray([1 / users[choice.user] for choice in choices])
    weights *= len(choices) / weights.sum()
    return x, y, sizes, starts, weights


class Ranker:
    def __init__(self, spec: Spec, columns: np.ndarray, seed: int = 71):
        self.spec = spec
        self.columns = columns
        self.seed = seed
        self.estimator = None
        self.fit_info = {}

    def fit(self, choices: list[Choice]) -> "Ranker":
        x, y, sizes, starts, weights = flatten(choices, self.columns)
        self.mean = x.mean(axis=0)
        self.scale = x.std(axis=0)
        self.scale[self.scale < 1e-12] = 1
        self.users = {user: index for index, user in enumerate(sorted({c.user for c in choices}))}
        if self.spec.family == "logit":
            z = (x - self.mean) / self.scale
            design = self._design(z, np.repeat([c.user for c in choices], sizes))
            group_weight = weights / weights.sum()
            row_weight = np.repeat(group_weight, sizes)
            penalty = np.full(design.shape[1], self.spec.regularization)
            penalty[z.shape[1] :] *= 10

            def objective(w: np.ndarray) -> tuple[float, np.ndarray]:
                scores = design @ w
                maxes = np.maximum.reduceat(scores, starts)
                exp = np.exp(scores - np.repeat(maxes, sizes))
                sums = np.add.reduceat(exp, starts)
                probs = exp / np.repeat(sums, sizes)
                loss = np.dot(group_weight, maxes + np.log(sums))
                loss -= np.dot(row_weight * y, scores)
                loss += 0.5 * np.dot(penalty * w, w)
                grad = design.T @ ((probs - y) * row_weight) + penalty * w
                return float(loss), np.asarray(grad).ravel()

            result = minimize(
                objective,
                np.zeros(design.shape[1]),
                jac=True,
                method="L-BFGS-B",
                options={"maxiter": 500, "ftol": 1e-10},
            )
            if not result.success:
                raise RuntimeError(f"Conditional logit did not converge: {result.message}")
            self.coefficients = result.x
            self.fit_info = {"converged": True, "iterations": result.nit}
        elif self.spec.family == "lightgbm":
            self.estimator = LGBMRanker(
                objective="lambdarank",
                metric="ndcg",
                lambdarank_truncation_level=6,
                n_estimators=self.spec.iterations,
                max_depth=self.spec.depth,
                num_leaves=2**self.spec.depth,
                learning_rate=0.03,
                min_child_samples=40,
                reg_lambda=5,
                verbosity=-1,
                deterministic=True,
                force_col_wise=True,
                n_jobs=2,
                random_state=self.seed,
            )
            self.estimator.fit(x, y, group=sizes, sample_weight=np.repeat(weights, sizes))
        elif self.spec.family == "catboost":
            self.estimator = CatBoostRanker(
                loss_function="YetiRank:mode=NDCG;top=3",
                depth=self.spec.depth,
                iterations=self.spec.iterations,
                learning_rate=0.03,
                l2_leaf_reg=5,
                random_seed=self.seed,
                thread_count=2,
                verbose=False,
                allow_writing_files=False,
            )
            self.estimator.fit(
                Pool(
                    x,
                    y,
                    group_id=np.repeat(np.arange(len(sizes)), sizes),
                    group_weight=np.repeat(weights, sizes),
                )
            )
        else:
            raise ValueError(f"Unknown model family: {self.spec.family}")
        return self

    def _design(self, z: np.ndarray, users: np.ndarray) -> csr_matrix:
        shared = csr_matrix(z)
        if not self.spec.personal:
            return shared
        width = z.shape[1]
        known = np.asarray([self.users.get(user, -1) for user in users])
        rows = np.repeat(np.flatnonzero(known >= 0), width)
        cols = (known[known >= 0, None] * width + np.arange(width)).ravel()
        personal = csr_matrix(
            (z[known >= 0].ravel(), (rows, cols)),
            shape=(len(z), width * len(self.users)),
        )
        return hstack([shared, personal], format="csr")

    def predict(self, choices: list[Choice]) -> list[np.ndarray]:
        sizes = np.asarray([len(choice.keys) for choice in choices])
        x = np.vstack([choice.x[:, self.columns] for choice in choices])
        if self.spec.family == "logit":
            z = (x - self.mean) / self.scale
            scores = (
                self._design(z, np.repeat([c.user for c in choices], sizes)) @ self.coefficients
            )
        else:
            scores = self.estimator.predict(x)
        return list(np.split(scores, np.cumsum(sizes)[:-1]))
