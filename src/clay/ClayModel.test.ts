import { describe, expect, it } from 'vitest';
import type { LevelDef } from '../types';
import { ClayModel } from './ClayModel';

const flat: LevelDef = {
  id: 't',
  target: 'mountain',
  title: '',
  intro: '',
  targets: [],
  tip: '',
  start: { type: 'flat' },
  budget: 0.05,
  conserveVolume: false,
  reveal: { name: '', fact: '' },
};

describe('ClayModel', () => {
  it('放黏土會扣黏土罐，而且放到的量等於扣掉的量', () => {
    const c = new ClayModel(128);
    c.reset(flat, 4000);
    c.apply({ kind: 'drop', u: 0.5, v: 0.5, radius: 0.09, volume: 0.0025 });
    expect(c.budget).toBeLessThan(0.05);
    expect(c.volume() + c.budget).toBeCloseTo(0.05, 5);
  });

  it('黏土罐空了就不能再放', () => {
    const c = new ClayModel(64);
    c.reset({ ...flat, budget: 0.001 }, 4000);
    expect(c.apply({ kind: 'drop', u: 0.5, v: 0.5, radius: 0.09, volume: 0.0025 })).toBe(true);
    expect(c.apply({ kind: 'drop', u: 0.3, v: 0.3, radius: 0.09, volume: 0.0025 })).toBe(false);
  });

  it('復原會回到上一步', () => {
    const c = new ClayModel(64);
    c.reset(flat, 4000);
    c.apply({ kind: 'raise', u: 0.5, v: 0.5, radius: 0.06, amount: 0.1 });
    c.apply({ kind: 'raise', u: 0.5, v: 0.5, radius: 0.06, amount: 0.1 });
    c.apply({ kind: 'commit' });
    const peak = c.heightAt(0.5, 0.5);
    expect(peak).toBeGreaterThan(0.15);
    c.apply({ kind: 'drop', u: 0.3, v: 0.3, radius: 0.09, volume: 0.001 });
    c.undo();
    expect(c.heightAt(0.5, 0.5)).toBeCloseTo(peak, 5);
    c.undo(); // 連續拉高算同一步
    expect(c.heightAt(0.5, 0.5)).toBe(0);
  });

  it('手掌壓會先壓最高處，壓出平面', () => {
    const c = new ClayModel(128);
    c.reset({ ...flat, start: { type: 'mound', height: 800, radius: 0.3 } }, 4000);
    for (let k = 0; k < 30; k++) c.apply({ kind: 'press', u: 0.5, v: 0.5, radius: 0.1, amount: 0.01 });
    const center = c.heightAt(0.5, 0.5);
    const near = c.heightAt(0.53, 0.5);
    expect(center).toBeLessThan(0.2);
    expect(Math.abs(center - near)).toBeLessThan(0.01);
  });

  it('總量守恆開啟時，壓下去的黏土會擠到旁邊', () => {
    const c = new ClayModel(128);
    c.reset({ ...flat, conserveVolume: true, start: { type: 'mound', height: 800, radius: 0.3 } }, 4000);
    const before = c.volume();
    for (let k = 0; k < 10; k++) c.apply({ kind: 'press', u: 0.5, v: 0.5, radius: 0.1, amount: 0.01 });
    expect(c.volume()).toBeCloseTo(before, 4);
  });
});
