import {
  Menu,
  shell,
  BrowserWindow,
  MenuItemConstructorOptions,
} from 'electron';
import { checkForUpdatesInteractively } from './updater';
import {
  MENU_COMMANDS,
  MENU_COMMAND_CHANNEL,
  toAccelerator,
  type MenuSection,
} from './menuCommands';

const SITE_URL = 'https://talyn.dev';
const SUPPORT_URL = 'https://github.com/Gilbert09/talyn/issues';

export default class MenuBuilder {
  mainWindow: BrowserWindow;

  constructor(mainWindow: BrowserWindow) {
    this.mainWindow = mainWindow;
  }

  buildMenu(): Menu {
    if (
      process.env.NODE_ENV === 'development' ||
      process.env.DEBUG_PROD === 'true'
    ) {
      this.setupDevelopmentEnvironment();
    }

    const template =
      process.platform === 'darwin'
        ? this.buildDarwinTemplate()
        : this.buildDefaultTemplate();

    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);

    return menu;
  }

  setupDevelopmentEnvironment(): void {
    this.mainWindow.webContents.on('context-menu', (_, props) => {
      const { x, y } = props;

      Menu.buildFromTemplate([
        {
          label: 'Inspect element',
          click: () => {
            this.mainWindow.webContents.inspectElement(x, y);
          },
        },
      ]).popup({ window: this.mainWindow });
    });
  }

  /**
   * Menu items for the renderer's shortcut registry. The menu owns these
   * chords (it sees them before the page does), and a click sends the id to
   * the renderer, which runs the shortcut registered under it.
   */
  commandItems(section: MenuSection): MenuItemConstructorOptions[] {
    const items: MenuItemConstructorOptions[] = [];
    for (const cmd of MENU_COMMANDS) {
      if (cmd.section !== section) continue;
      if (cmd.separatorBefore && items.length > 0) items.push({ type: 'separator' });
      items.push({
        label: cmd.label,
        accelerator: toAccelerator(cmd.keys),
        click: () => {
          this.mainWindow.webContents.send(MENU_COMMAND_CHANNEL, cmd.id);
        },
      });
    }
    return items;
  }

  buildDarwinTemplate(): MenuItemConstructorOptions[] {
    // Explicit labels on the role items: bare roles interpolate `app.name`,
    // which is the package.json `name` ("fastowl" — kept for the userData
    // path and deep-link scheme), not the user-facing product name.
    const subMenuApp: MenuItemConstructorOptions = {
      label: 'Talyn',
      submenu: [
        { role: 'about', label: 'About Talyn' },
        {
          label: 'Check for Updates…',
          click: () => {
            void checkForUpdatesInteractively();
          },
        },
        { type: 'separator' },
        ...this.commandItems('app'),
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide', label: 'Hide Talyn' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit', label: 'Quit Talyn' },
      ],
    };
    const subMenuFile: MenuItemConstructorOptions = {
      label: 'File',
      submenu: this.commandItems('file'),
    };
    const subMenuEdit: MenuItemConstructorOptions = {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    };
    const subMenuViewDev: MenuItemConstructorOptions = {
      label: 'View',
      submenu: [
        ...this.commandItems('view'),
        { type: 'separator' },
        {
          // ⌘R is left free for the workbench; reload moves to ⌘⇧R.
          label: 'Reload',
          accelerator: 'Command+Shift+R',
          click: () => {
            this.mainWindow.webContents.reload();
          },
        },
        {
          label: 'Toggle Full Screen',
          accelerator: 'Ctrl+Command+F',
          click: () => {
            this.mainWindow.setFullScreen(!this.mainWindow.isFullScreen());
          },
        },
        {
          label: 'Toggle Developer Tools',
          accelerator: 'Alt+Command+I',
          click: () => {
            this.mainWindow.webContents.toggleDevTools();
          },
        },
      ],
    };
    const subMenuViewProd: MenuItemConstructorOptions = {
      label: 'View',
      submenu: [
        ...this.commandItems('view'),
        { type: 'separator' },
        {
          label: 'Toggle Full Screen',
          accelerator: 'Ctrl+Command+F',
          click: () => {
            this.mainWindow.setFullScreen(!this.mainWindow.isFullScreen());
          },
        },
      ],
    };
    const subMenuWorkbench: MenuItemConstructorOptions = {
      label: 'Session',
      submenu: this.commandItems('workbench'),
    };
    const subMenuWindow: MenuItemConstructorOptions = {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        // ⌘W closes the chat tab (File menu); the window takes ⌘⇧W.
        { role: 'close', accelerator: 'Command+Shift+W' },
        { type: 'separator' },
        { role: 'front' },
      ],
    };
    const subMenuHelp: MenuItemConstructorOptions = {
      label: 'Help',
      submenu: [
        {
          label: 'Talyn Website',
          click() {
            shell.openExternal(SITE_URL);
          },
        },
        {
          label: 'Report an Issue',
          click() {
            shell.openExternal(SUPPORT_URL);
          },
        },
      ],
    };

    const subMenuView =
      process.env.NODE_ENV === 'development' ||
      process.env.DEBUG_PROD === 'true'
        ? subMenuViewDev
        : subMenuViewProd;

    return [
      subMenuApp,
      subMenuFile,
      subMenuEdit,
      subMenuView,
      subMenuWorkbench,
      subMenuWindow,
      subMenuHelp,
    ];
  }

  buildDefaultTemplate(): MenuItemConstructorOptions[] {
    const templateDefault: MenuItemConstructorOptions[] = [
      {
        label: '&File',
        submenu: [
          ...this.commandItems('file'),
          { type: 'separator' },
          ...this.commandItems('app'),
          { type: 'separator' },
          {
            // Ctrl+W closes the chat tab; the window takes Ctrl+Shift+W.
            label: '&Close Window',
            accelerator: 'Ctrl+Shift+W',
            click: () => {
              this.mainWindow.close();
            },
          },
        ],
      },
      {
        label: '&View',
        submenu:
          process.env.NODE_ENV === 'development' ||
          process.env.DEBUG_PROD === 'true'
            ? [
                ...this.commandItems('view'),
                { type: 'separator' },
                {
                  label: '&Reload',
                  accelerator: 'Ctrl+Shift+R',
                  click: () => {
                    this.mainWindow.webContents.reload();
                  },
                },
                {
                  label: 'Toggle &Full Screen',
                  accelerator: 'F11',
                  click: () => {
                    this.mainWindow.setFullScreen(
                      !this.mainWindow.isFullScreen(),
                    );
                  },
                },
                {
                  label: 'Toggle &Developer Tools',
                  accelerator: 'Alt+Ctrl+I',
                  click: () => {
                    this.mainWindow.webContents.toggleDevTools();
                  },
                },
              ]
            : [
                ...this.commandItems('view'),
                { type: 'separator' },
                {
                  label: 'Toggle &Full Screen',
                  accelerator: 'F11',
                  click: () => {
                    this.mainWindow.setFullScreen(
                      !this.mainWindow.isFullScreen(),
                    );
                  },
                },
              ],
      },
      {
        label: '&Session',
        submenu: this.commandItems('workbench'),
      },
      {
        label: 'Help',
        submenu: [
          {
            label: 'Talyn Website',
            click() {
              shell.openExternal(SITE_URL);
            },
          },
          {
            label: 'Report an Issue',
            click() {
              shell.openExternal(SUPPORT_URL);
            },
          },
          { type: 'separator' },
          {
            label: 'Check for Updates…',
            click() {
              void checkForUpdatesInteractively();
            },
          },
        ],
      },
    ];

    return templateDefault;
  }
}
