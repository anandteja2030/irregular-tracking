"""Phase 3 - Kalman filter tracking.

State model: [x, y, vx, vy, w, h] operating on constant velocity in the
(x, y) axes with (w, h) as slowly-varying size states. Measurements are the
(cx, cy, w, h) of a detection.

Written in pure NumPy (no filterpy dependency), and unit-tested against
analytic constant-velocity trajectories.
"""
from __future__ import annotations

import numpy as np


class KalmanBox:
    """Minimal constant-velocity Kalman filter for a bounding-box-like object."""

    STATE_DIM = 6
    MEAS_DIM = 4

    def __init__(self, cx: float, cy: float, w: float, h: float,
                 process_noise: float = 2.0, measurement_noise: float = 12.0):
        self.dt = 1.0
        self.x = np.zeros(self.STATE_DIM, dtype=float)
        self.x[:4] = [cx, cy, w, h]
        self.P = np.eye(6) * 20.0
        self.F = self._F(self.dt)
        self.H = self._H()
        self.q = process_noise
        self.r = measurement_noise

    # ---------------------------------------------------------------- setup
    @classmethod
    def _F(cls, dt: float) -> np.ndarray:
        F = np.eye(6)
        # position <- position + dt*velocity; velocity persists
        F[0, 4] = dt   # x <- x + vx*dt
        F[1, 5] = dt   # y <- y + vy*dt
        return F

    @classmethod
    def _H(cls) -> np.ndarray:
        H = np.zeros((4, 6))
        H[0, 0] = 1.0            # cx
        H[1, 1] = 1.0            # cy
        H[2, 2] = 1.0            # w
        H[3, 3] = 1.0            # h
        return H

    # ---------------------------------------------------------------- steps
    def predict(self) -> np.ndarray:
        self.F = self._F(self.dt)
        self.x = self.F @ self.x
        self.P = self.F @ self.P @ self.F.T + self.Q()
        return self.x.copy()

    def Q(self) -> np.ndarray:
        """Process noise; velocity uncertainty grows each step."""
        Q = np.eye(6) * 0.1
        Q[4, 4] = self.q
        Q[5, 5] = self.q
        return Q

    def update(self, cx: float, cy: float, w: float, h: float) -> None:
        z = np.array([cx, cy, w, h], dtype=float)
        R = np.eye(4) * self.r
        y = z - self.H @ self.x
        S = self.H @ self.P @ self.H.T + R
        K = self.P @ self.H.T @ np.linalg.inv(S)
        self.x = self.x + K @ y
        self.P = (np.eye(6) - K @ self.H) @ self.P

    # ---------------------------------------------------------------- views
    @property
    def centroid(self) -> tuple[float, float]:
        return float(self.x[0]), float(self.x[1])

    @property
    def velocity(self) -> tuple[float, float]:
        return float(self.x[4]), float(self.x[5])

    @property
    def box_wh(self) -> tuple[float, float]:
        return float(self.x[2]), float(self.x[3])
