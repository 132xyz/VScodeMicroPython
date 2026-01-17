// Script de prueba para ejecutar la función checkDiffs con paths específicos
const path = require('path');
const fs = require('fs').promises;

// Simular las funciones necesarias
function toDevicePath(localRel: string, rootPath: string): string {
  // 转换本地相对路径为设备路径（调试输出已移除）

  // Normalize paths
  const normalizedLocalPath = localRel.replace(/\/+/g, '/').replace(/\/$/, '');
  const normalizedRootPath = rootPath.replace(/\/+/g, '/').replace(/\/$/, '');

  // normalized paths

  // If root is just "/", add leading slash to local path
  if (normalizedRootPath === "") {
    const result = "/" + normalizedLocalPath;
    // 根目录为 /
    return result;
  }

  // If local path is empty, return root path
  if (normalizedLocalPath === "") {
    // 本地路径为空
    return normalizedRootPath;
  }

  // Combine root and local path
  const result = normalizedRootPath + "/" + normalizedLocalPath;
  // 返回组合路径结果
  return result;
}

function relFromDevice(devicePath: string, rootPath: string): string {
  // 将设备路径转为本地相对路径（调试输出已移除）

  // Normalize paths to ensure consistent comparison
  const normalizedDevicePath = devicePath.replace(/\/+/g, '/').replace(/\/$/, '');
  const normalizedRootPath = rootPath.replace(/\/+/g, '/').replace(/\/$/, '');

  // normalized paths

  // If root is just "/", remove leading slash from device path
  if (normalizedRootPath === "") {
    const result = normalizedDevicePath.replace(/^\//, "");
    // 根路径为 /
    return result;
  }

  // If device path starts with root path, remove the root prefix
  if (normalizedDevicePath.startsWith(normalizedRootPath + "/")) {
    const result = normalizedDevicePath.slice(normalizedRootPath.length + 1);
    // path starts with root
    return result;
  }

  // If device path equals root path, return empty string
  if (normalizedDevicePath === normalizedRootPath) {
    // path equals root
    return "";
  }

  // Fallback: remove leading slash if present
  const result = normalizedDevicePath.replace(/^\//, "");
  // fallback result
  return result;
}

// Función principal de prueba
async function testCheckDiffs() {
  // starting diff check

  const rootPath = "/";

  // Datos de prueba proporcionados por el usuario
  const testData = {
    localPath: "/Users/danielbustillos/Desktop/tmp/test-folder/test_inside_folder.py",
    localRelative: "test-folder/test_inside_folder.py",
    boardPath: "/test-folder/test_inside_folder.py"
  };

  // 输出测试数据（已省略）

  // Simular la lógica de comparación
  const localRel = testData.localRelative;
  const abs = testData.localPath;

  // 比较本地文件与设备文件

  // Simular que encontramos el archivo en el dispositivo
  const deviceFile = {
    path: testData.boardPath,
    size: 1024, // Simular tamaño del archivo en el dispositivo
    isDir: false
  };

  // 设备文件是否找到

  if (deviceFile) {
    // 匹配到设备文件

    try {
      // Simular obtener el tamaño del archivo local
      const st = { size: 1024 }; // Simular stat del archivo local
      // 比较大小

      if (st.size !== deviceFile.size) {
        // 标记为不同（尺寸不一致）
      } else {
        // 文件一致
      }
    } catch (error) {
      console.error(`checkDiffs: Local file not accessible: ${abs}, error: ${error}`);
    }
  } else {
    // 未在设备上找到文件，标记为本地唯一
  }

  // diff log end

  // Probar las funciones de conversión de paths
  // PATH CONVERSION TESTS
  const devicePathFromLocal = toDevicePath(testData.localRelative, rootPath);
  // toDevicePath result omitted

  const localRelativeFromDevice = relFromDevice(testData.boardPath, rootPath);
  // relFromDevice result omitted

  // test completed
}

// Ejecutar la prueba
testCheckDiffs().catch(console.error);