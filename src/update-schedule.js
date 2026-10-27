'use strict';

const INTERVALS = [15, 30, 60, 360, 720, 1440];
function intervalMinutes(value) {
  const minutes = Number(value);
  return INTERVALS.includes(minutes) ? minutes : 60;
}

function createUpdateSchedule({ check, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let timer = null;
  let settings = {};
  function cancel() {
    if (timer !== null) clearTimer(timer);
    timer = null;
  }
  function schedule(delay) {
    if (settings.autoUpdateCheck === false) return;
    timer = setTimer(() => {
      timer = null;
      Promise.resolve().then(check).catch(() => {});
      schedule(intervalMinutes(settings.autoUpdateCheckMin) * 60 * 1000);
    }, delay);
  }
  return {
    configure(next, { startup = false } = {}) {
      cancel();
      settings = { ...next };
      schedule(startup ? 15000 : intervalMinutes(settings.autoUpdateCheckMin) * 60 * 1000);
    },
    stop: cancel,
  };
}

module.exports = { intervalMinutes, createUpdateSchedule };
