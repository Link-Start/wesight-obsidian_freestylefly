export const CHROME_EXTENSION_DOWNLOAD_URL =
  'https://github.com/freestylefly/wesight-chrome/releases/latest/download/wesight-chrome.zip';
export const CHROME_EXTENSIONS_URL = 'chrome://extensions/';

export const CHROME_INSTALL_STEPS = [
  {
    title: '下载浏览器插件',
    description: '下载 WeSight 发布助手 ZIP 安装包。',
  },
  {
    title: '解压安装包',
    description: '把 wesight-chrome.zip 解压为完整文件夹。',
  },
  {
    title: '打开扩展管理页',
    description: '进入 Chrome、Edge 或 Arc 的扩展程序管理页面。',
  },
  {
    title: '加载插件文件夹',
    description: '开启右上角“开发者模式”，点击左上角“加载已解压的扩展程序”，选择刚解压的 wesight-chrome 文件夹；也可以把该文件夹拖入此页面。',
  },
] as const;
