import type { FlappyState } from './types.js';

export type Label = 0 | 1;
export type TeacherFn = (state: FlappyState, features: Float32Array) => Label;

/** Default Flappy Bird teacher: flap when below target, falling, or near bottom. */
export const defaultTeacher: TeacherFn = (state, _features) => {
  const below = state.birdY > state.gapCenterY + 8;
  const falling = state.birdVelocityY > -60;
  const danger = state.birdY > state.gapBottom - 38;
  return (below && falling) || danger ? 1 : 0;
};