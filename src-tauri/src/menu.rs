//! The native menu bar: Tauri's default menu plus Help › Keyboard Shortcuts
//! (⌘/), which emits `SHOW_KEYS_EVENT` (§7.4 v1.8) so the UI lays its Keys
//! card over the current screen, as "?" does (critique round 6, P1-3).

use tauri::menu::{HELP_SUBMENU_ID, Menu, MenuEvent, MenuItem, MenuItemKind, Submenu};
use tauri::{AppHandle, Runtime};

/// Menu id of Help › Keyboard Shortcuts.
pub const KEYBOARD_SHORTCUTS_ID: &str = "help-keyboard-shortcuts";
const KEYBOARD_SHORTCUTS_TEXT: &str = "Keyboard Shortcuts";
const KEYBOARD_SHORTCUTS_ACCELERATOR: &str = "CmdOrCtrl+/";

/// The default menu with Keyboard Shortcuts appended to its Help submenu
/// (created when a platform's default has none). On macOS Tauri makes that
/// submenu the app's Help menu, with its search field.
///
/// Native menus are created on the main thread only (muda), so tests cover
/// `app_event_for` and `on_menu_event`; `build` runs in the real app.
///
/// # Errors
/// If the native menu cannot be created.
pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let menu = Menu::default(app)?;
    let shortcuts = MenuItem::with_id(
        app,
        KEYBOARD_SHORTCUTS_ID,
        KEYBOARD_SHORTCUTS_TEXT,
        true,
        Some(KEYBOARD_SHORTCUTS_ACCELERATOR),
    )?;
    if let Some(MenuItemKind::Submenu(help)) = menu.get(HELP_SUBMENU_ID) {
        help.append(&shortcuts)?;
    } else {
        menu.append(&Submenu::with_id_and_items(
            app,
            HELP_SUBMENU_ID,
            "Help",
            true,
            &[&shortcuts],
        )?)?;
    }
    Ok(menu)
}

/// The app event a menu item stands for; None for the predefined items,
/// which the OS handles itself.
#[must_use]
pub fn app_event_for(id: &str) -> Option<&'static str> {
    (id == KEYBOARD_SHORTCUTS_ID).then_some(crate::ipc::SHOW_KEYS_EVENT)
}

/// `Builder::on_menu_event`: forwards the app's own items to the UI.
pub fn on_menu_event<R: Runtime>(app: &AppHandle<R>, event: &MenuEvent) {
    if let Some(name) = app_event_for(event.id().as_ref()) {
        crate::commands::app::emit_app_event(app, name);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_keyboard_shortcuts_maps_to_an_app_event() {
        assert_eq!(
            app_event_for(KEYBOARD_SHORTCUTS_ID),
            Some(crate::ipc::SHOW_KEYS_EVENT)
        );
        assert_eq!(app_event_for("about"), None);
        assert_eq!(app_event_for(""), None);
    }
}
