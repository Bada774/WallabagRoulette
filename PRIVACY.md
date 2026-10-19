# Privacy Policy: Wallabag Roulette

_Last updated: 2026-10-19_

Wallabag Roulette ("the extension") picks a random unread entry from your own wallabag server and saves pages you choose to that server. The extension does not collect, sell or share personal data. It has no analytics, no advertising and no servers of its own.

## What the extension stores

All of this stays in your browser (`chrome.storage`):

- the address of your wallabag server, client ID, client secret, username and password, and the access and refresh tokens obtained from your server;
- your settings (tag, notification schedule);
- the currently picked entry (title, address, domain, tags, preview address);
- tag statistics and the list of tags used for new entries;
- the queue of pages (address and title) waiting to be saved.

Credentials are stored without additional encryption.

## What the extension sends, and where

Requests go **only to the wallabag server address you entered**. They are used to sign in (OAuth), read entries and tags, save the addresses and titles of the pages you chose to add (from the popup, the context menu or the hotkey), and archive entries you mark as watched.

The extension does not contact any other server, does not read page content, and does not track your browsing. It reads the address and title of a tab only when you ask it to add that tab (or all tabs of the window), or to add a link.

Your wallabag server is operated by you or by your provider. How it handles data is governed by its own policy.

## Permissions

The extension asks for access to the single server address you enter in the settings. It requests the permission when you save the settings and removes it when you press _Sign out_ or _Reset everything_.

## Removing your data

- **Sign out** (settings → Saved data): removes the server address, credentials, tokens and the add queue.
- **Reset everything**: removes all data the extension stores, including settings and statistics.
- Uninstalling the extension removes all of its data from the browser.

Data already saved in wallabag is not affected. Manage it in wallabag itself.

## Children

The extension is not directed at children and does not knowingly collect data from them.

## Changes

If this policy changes, the date above is updated and the change is published in this repository.

## Contact

![Contact](https://github.com/bada774/WallabagRoulette/issues)
