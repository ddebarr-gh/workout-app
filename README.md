# Garage 5/3/1

A lightweight, offline-capable workout checklist driven by a YAML program.

The app is designed primarily for phones, but it also works in modern desktop browsers. It requires no account, database, or cloud service.

## Features

- YAML-defined exercises, training maxima, warm-ups, and prescriptions
- 5/3/1 weeks, including deload
- Boring But Big, First Set Last, and custom prescriptions
- Ascending or descending work sets
- Tickable warm-up and work sets
- AMRAP (As Many Reps As Possible) repetition recording
- Superset rounds
- Current-set and total-workout timers
- Local workout history
- Backup export and import
- Offline use after installation

## Try it

A hosted version can be published using GitHub Pages:

`https://ddebarr-gh.github.io/workout-app/`

The weights in the included `program.yaml` are examples only. They are not training recommendations.

## Installation

### iPhone or iPad

1. Open the hosted app in Safari.
2. Tap **Share**.
3. Tap **Add to Home Screen**.
4. Leave **Open as Web App** enabled.
5. Tap **Add**.

### Android

Open the app in Chrome and choose **Install app** or **Add to Home screen** from the browser menu.

### Desktop

The app works directly in a browser. Browsers with Progressive Web App support may also offer an installation button.

## Configuring the program

The workout program is stored in `program.yaml`.

Reference weights are divided into training maxima and fixed weights:

```yaml
reference_weights:
  training_max:
    - barbell_bench_press: 100
    - barbell_back_squat: 100

  non_programmed_weight:
    - lateral_raise: 10
    - wrist_curl: 10
```

A basic prescription looks like this:

```yaml
prescriptions:
  3x10:
    - sets: 3
      reps: 10
```

A phased set can describe exercises such as 21s:

```yaml
prescriptions:
  3x21:
    - sets: 3
      phases:
        - {name: lower_partials, reps: 7}
        - {name: upper_partials, reps: 7}
        - {name: full_range, reps: 7}
```

Exercises are assigned to training days under `plan`:

```yaml
plan:
  bench_day:
    - exercise: barbell_bench_press
      prescription: 5-3-1
      warmup: 5-3-1_descending
      work_set_order: descending
```

Adjacent exercises with the same `superset` name are presented as paired rounds:

```yaml
- exercise: wrist_curl
  prescription: 3x10
  superset: wrist

- exercise: reverse_wrist_curl
  prescription: 3x10
  superset: wrist
```

Each exercise’s weight is still calculated independently.

## Loading a changed program

The app preserves its active program and selected day locally.

After replacing the hosted `program.yaml`:

1. Open the **Program** tab.
2. Tap **Reload bundled**.
3. Tap **Validate and activate**.

The `initial_state` values are used only when no saved selection exists. Existing users can select the desired week and day from the **Today** screen.

Users can also load YAML from a file or an HTTPS URL.

## Data and privacy

Workout history, AMRAP results, and the active program are stored locally in the browser. The app does not send workout data to a server.

Safari and an installed Home Screen app may maintain separate local storage. Use **Export backup** and **Import backup** to move data between them.

Clearing browser data or uninstalling the app may remove workout history. Export backups periodically.

## Running locally

Because the app loads `program.yaml` through the browser, serve the directory with a local web server instead of opening `index.html` directly:

```sh
python3 -m http.server 8000
```

Then visit:

`http://localhost:8000/`

## Publishing with GitHub Pages

1. Put the app files in a GitHub repository.
2. Open the repository’s **Settings**.
3. Select **Pages**.
4. Publish from the `main` branch and repository root.
5. Open the GitHub Pages address shown by GitHub.

## Disclaimer

This software is a workout-recording tool, not medical or professional training advice. The included exercises and weights are examples. Users are responsible for choosing appropriate exercises and loads.

## License

This project is available under the [MIT License](LICENSE).

The bundled `js-yaml` library is distributed under its own MIT license. See `vendor/js-yaml.LICENSE`.
