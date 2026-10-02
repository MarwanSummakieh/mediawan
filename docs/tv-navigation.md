# TV remote navigation

The full website supports TV remotes: home and libraries, search, title and
episode details, playback menus, Watch together, live sports and the programme
guide, sign-in/invites, and administration.

TV mode starts automatically on Samsung Tizen. To preview it in a browser,
open `/?tv=1`. The setting persists across navigation and sign-in. To clear the
browser preview, remove the `tv` entry from local storage and reload.

## Remote controls

| Key | Behavior |
| --- | --- |
| Arrows | Move the visible focus highlight; content scrolls into view. |
| OK / Enter | Activate a button or link, toggle a checkbox, or open an option list. |
| OK on a text field | Open the keyboard and start editing. |
| OK while editing | Finish editing. Search then moves to the results. |
| Up / Down while editing | Finish editing and move to the next or previous control. |
| Back / Escape | Finish editing, cancel an option list, or close the innermost open panel. |
| Left / Right on a slider | Adjust by the field's configured step. |
| Left at the start of a browse row | Enter the navigation rail. Right returns to content. |

Native select fields use an on-page option dialog in TV mode. Back cancels
without changing the value; OK chooses an option. Scrollable guide, schedule,
table and setup regions can receive focus so their contents remain readable.
Disabled and hidden controls are skipped. Replacing a list or closing a dialog
restores focus to the same control when it is still available.

## Playback

Over the film, OK toggles playback and Left / Right seek. Up or Down enters the
control bar. Within controls, Left / Right move between buttons; Up reaches the
timeline and then the title bar, including Watch together. Left / Right on the
timeline seek. Down returns through the controls; Down from the bottom row
returns to the film. Back closes menus before leaving the controls or player.
Live TV exposes separate play/pause, jump-to-live, mute and volume buttons.

## 4K layout and video

TV sizing follows the browser's viewport width through the shared
`--tv-scale` value:

| Viewport width | Scale |
| --- | --- |
| Below 2400px, including 1920×1080 and 1280×720 | 1; the existing narrow-TV layout still applies. |
| 2400–2999px | 1.5 |
| 3000px and above, including 3840×2160 | 2 |

Every website surface uses this scale for text, controls, spacing and focus
highlights. Arrow navigation, row positioning and scroll distances use the
same value, including after a viewport resize.

The player's output menu already offers **2160p (4K)**. Actual video resolution
depends on the source and the device's decoder support. Samsung's packaged TV
apps usually use a 1920×1080 application canvas even on UHD panels; a browser
that exposes a native 3840×2160 viewport uses the larger layout. Application
canvas and video resolution are separate. See Samsung's
[screen resolution guide](https://developer.samsung.com/smarttv/develop/guides/fundamentals/managing-screen-resolution.html)
and [UHD video guide](https://developer.samsung.com/smarttv/develop/guides/multimedia/4k-8k-uhd-video.html).

## Implementation and validation

`public/tv.js` provides navigation shared by every page. Use native buttons,
links and form fields for actions. Clickable custom controls must have a role
and keyboard focus target. Give dynamically rendered controls a stable
`data-tv-key` or `id` to preserve focus. Modal dialogs use `aria-modal="true"`
and a Cancel/Close button marked `data-close-modal`. Scroll regions use
`data-tv-scroll` and an accessible label.

TV styling is scoped to `html.tv`; normal browser controls keep their usual
behavior. Run `npm test` for navigation and application regression tests, and
`npm run build:tv` to regenerate assets for Chromium 69 / Tizen 5.5.

The regression suite has 418 tests, including 4K navigation and resize cases.
Browser checks cover 3840×2160, 1920×1080 and 1280×720 with local sample data.
Physical remote/IME behavior and hardware video rendering still require a TV
check.
