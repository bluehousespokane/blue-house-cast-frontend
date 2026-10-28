import { assert, describe, it } from "vitest";
import type { HassEntity } from "home-assistant-js-websocket";
import { getAmbientDisplayData } from "../../cast/src/receiver/ambient";

const now = new Date("2026-10-28T10:30:00-07:00");

function mealEntity(
  entries: unknown[],
  lastRefresh = now.toISOString()
): HassEntity {
  return {
    entity_id: "sensor.household_meals_display",
    state: String(entries.length),
    attributes: {
      entries_json: JSON.stringify(entries),
      last_refresh: lastRefresh,
    },
    last_changed: now.toISOString(),
    last_updated: now.toISOString(),
    context: { id: "test", user_id: null, parent_id: null },
  };
}

function weatherEntity(
  lastUpdated = now.toISOString(),
  temperature = 5.7,
  temperatureUnit = "°C"
): HassEntity {
  return {
    entity_id: "weather.forecast_home",
    state: "rainy",
    attributes: {
      temperature,
      temperature_unit: temperatureUnit,
    },
    last_changed: lastUpdated,
    last_updated: lastUpdated,
    context: { id: "test", user_id: null, parent_id: null },
  };
}

describe("Ambient receiver data", () => {
  it("formats the live weather and selects the next meal using local cutoffs", () => {
    const meals = mealEntity([
      {
        mealplan_date: "2026-10-28",
        entry_type: "breakfast",
        title: "Oatmeal",
      },
      {
        mealplan_date: "2026-10-28",
        entry_type: "lunch",
        title: "Tomato soup",
      },
      { mealplan_date: "2026-10-28", entry_type: "dinner", title: "Tacos" },
    ]);

    const result = getAmbientDisplayData(
      weatherEntity(),
      meals,
      now,
      "America/Los_Angeles",
      true
    );

    assert.equal(result.outside, "42°F / 6°C · Rainy");
    assert.equal(result.meal, "Tomato soup");
    assert.equal(result.mealHeading, "Lunch");
    assert.equal(result.mealLabel, "Lunch: Tomato soup");
    assert.equal(result.outsideLabel, "Outside: 42°F / 6°C · Rainy");
  });

  it("labels a tomorrow meal and shows its name without the meal type", () => {
    const late = new Date("2026-10-29T02:30:00Z");
    const meals = mealEntity(
      [
        { mealplan_date: "2026-10-28", entry_type: "dinner", title: "Tacos" },
        {
          mealplan_date: "2026-10-29",
          entry_type: "breakfast",
          title: "Toast",
        },
        { mealplan_date: "2026-10-30", entry_type: "dinner", title: "Pasta" },
      ],
      late.toISOString()
    );

    const result = getAmbientDisplayData(
      undefined,
      meals,
      late,
      "America/Los_Angeles",
      true
    );

    assert.equal(result.meal, "Toast");
    assert.equal(result.mealHeading, "Tomorrow's Breakfast");
    assert.equal(result.mealLabel, "Tomorrow's Breakfast: Toast");
    assert.equal(result.outside, "Weather unavailable");
  });

  it("does not show meals scheduled later than tomorrow", () => {
    const meals = mealEntity([
      { mealplan_date: "2026-10-30", entry_type: "dinner", title: "Pasta" },
    ]);
    const result = getAmbientDisplayData(
      weatherEntity(),
      meals,
      now,
      "America/Los_Angeles",
      true
    );

    assert.equal(result.mealHeading, "Next meal");
    assert.equal(result.meal, "Nothing planned through tomorrow");
  });

  it("converts Fahrenheit weather to include both temperature units", () => {
    const result = getAmbientDisplayData(
      weatherEntity(now.toISOString(), 42, "°F"),
      undefined,
      now,
      "America/Los_Angeles",
      true
    );

    assert.equal(result.outside, "42°F / 6°C · Rainy");
  });

  it("marks stale and offline sources without hiding their known values", () => {
    const staleAt = new Date(now.getTime() - 3 * 60 * 60 * 1000).toISOString();
    const result = getAmbientDisplayData(
      weatherEntity(staleAt),
      mealEntity(
        [{ mealplan_date: "2026-10-28", entry_type: "lunch", title: "Soup" }],
        staleAt
      ),
      now,
      "America/Los_Angeles",
      false
    );

    assert.equal(result.outside, "42°F / 6°C · Rainy · Stale · Offline");
    assert.equal(result.meal, "Soup");
    assert.equal(result.mealHeading, "Lunch · Stale · Offline");
  });
});
