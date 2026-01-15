// Mock for VS Code API
export const window = {
  showWarningMessage: jest.fn(),
  showErrorMessage: jest.fn(),
  showInformationMessage: jest.fn(),
  withProgress: jest.fn(),
  createStatusBarItem: jest.fn(),
};

export const commands = {
  executeCommand: jest.fn(),
};

export const env = {
  clipboard: {
    writeText: jest.fn(),
  },
  openExternal: jest.fn(),
};

export const ProgressLocation = {
  Notification: 1,
};

export const StatusBarAlignment = {
  Left: 1,
};

export const ThemeColor = jest.fn();

export const workspace = {
  getConfiguration: jest.fn(),
  workspaceFolders: [],
};

export const extensions = {
  getExtension: jest.fn(),
};

export const Uri = {
  parse: jest.fn(),
};