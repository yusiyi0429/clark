-- V2 第 20.6 节：本机程序加「同时跑的上限」，超出的排队，会话状态多一个 queued（等空位）。先放开这一种状态，本机程序报上来时不被库拒掉。
ALTER TABLE local_runs DROP CONSTRAINT local_runs_state_check;
ALTER TABLE local_runs ADD CONSTRAINT local_runs_state_check CHECK (state IN ('queued', 'starting', 'running', 'waiting_permission', 'idle', 'exited', 'failed'));
