import * as vscode from 'vscode';
import type { BoardDetectInfo } from './mpremote';

class BoardInfoService {
  private info: BoardDetectInfo | null = null;
  private _onDidChange = new vscode.EventEmitter<BoardDetectInfo | null>();

  public getBoardInfo(): BoardDetectInfo | null {
    return this.info;
  }

  public setBoardInfo(info: BoardDetectInfo | null) {
    this.info = info;
    this._onDidChange.fire(this.info);
  }

  public clearBoardInfo() {
    this.setBoardInfo(null);
  }

  public onDidChange(listener: (info: BoardDetectInfo | null) => any) {
    return this._onDidChange.event(listener);
  }
}

export const boardInfoService = new BoardInfoService();

export default boardInfoService;
