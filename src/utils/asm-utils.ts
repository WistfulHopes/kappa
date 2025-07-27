import * as vscode from 'vscode';
import * as path from 'path';
import { getWorkspaceRoot } from './vscode-utils';

/**
 * Extract function name from assembly code.
 * @param asmCode Assembly function to extract its name
 * @returns The function name, or null if not found
 */
export function extractFunctionName(asmCode: string): string | null {
  const lines = asmCode.trim().split('\n');

  for (const line of lines) {
    const functionName = extractFunctionNameFromLine(line);
    if (functionName) {
      return functionName;
    }
  }

  return null;
}

export function extractFunctionNameFromLine(line: string): string | null {
  const trimmed = line.trim();

  // Look for thumb_func_start
  const glabelMatch = trimmed.match(/glabel\s+(\w+)/);
  if (glabelMatch) {
    return glabelMatch[1];
  }

  return null;
}

/**
 * Extract function calls from assembly code
 * @param assembly Assembly function code to analyze
 * @returns Array of function names called in the assembly
 */
export function extractFunctionCallsFromAssembly(assembly: string): string[] {
  const functionCalls = new Set<string>();
  const lines = assembly.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();

    // Look for jal (jump and link) instructions
    const jalMatch = trimmed.match(/jal\s+(\w+)/);
    if (jalMatch) {
      functionCalls.add(jalMatch[1]);
    }

    // Look for function references in comments or data
    const refMatch = trimmed.match(/@\s*=(\w+)/);
    if (refMatch) {
      functionCalls.add(refMatch[1]);
    }

    // Look for direct function calls or references
    const directMatch = trimmed.match(/(?:la|add|move).*=(\w+)/);
    if (directMatch) {
      functionCalls.add(directMatch[1]);
    }
  }

  return Array.from(functionCalls);
}

/**
 * Extract a specific function from assembly code
 * @param assemblyContent The assembly file content
 * @param functionName The name of the function to extract
 * @returns The assembly function code or null if not found
 */
export function extractAssemblyFunction(assemblyContent: string, functionName: string): string | null {
  const lines = assemblyContent.split('\n');
  let functionStart = -1;
  let functionEnd = -1;
  let inFunction = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // If we haven't found the function start yet, look for it
    if (!inFunction) {
      // Look for thumb_func_start or arm_func_start with the function name
      if (line.includes(`glabel ${functionName}`)) {
        functionStart = i;
        inFunction = true;
        continue;
      }

      // Look for function label
      if (line.startsWith(`${functionName}:`) && functionStart === -1) {
        functionStart = i;
        inFunction = true;
      }
    } else {
      // If we're in a function, look for the end

      // Look for thumb_func_end or arm_func_end
      if (line.includes(`.size ${functionName}`)) {
        functionEnd = i;
        break;
      }

      // Look for the next function start (indicating this function has ended)
      if (line.includes('glabel')) {
        // Find the actual end of the current function by looking backwards for function data
        for (let j = i - 1; j >= functionStart; j--) {
          const prevLine = lines[j].trim();
          // Look for the last piece of function data (constants, labels)
          if (
            prevLine.startsWith('.size') ||
            prevLine === '.align 3'
          ) {
            functionEnd = j;
            break;
          }
          // If we find a return instruction, include everything after it until we hit function data
          if (prevLine.startsWith('jr ')) {
            // Continue scanning for function data after the return
            for (let k = j + 1; k < i; k++) {
              const nextLine = lines[k].trim();
              if (
                prevLine.startsWith('.size') ||
                prevLine === '.align 3'
              ) {
                functionEnd = k;
              } else if (nextLine !== '' && !nextLine.startsWith('.align')) {
                break;
              }
            }
            if (functionEnd === -1) {
              functionEnd = j;
            }
            break;
          }
        }
        if (functionEnd === -1) {
          functionEnd = i - 1;
        }
        break;
      }
    }
  }

  // Extract the function
  if (functionStart !== -1 && functionEnd !== -1 && functionEnd >= functionStart) {
    return lines.slice(functionStart, functionEnd + 1).join('\n');
  }

  return null;
}

/**
 * List all functions from a assembly module source
 * @param assemblyContent The assembly module souce
 * @returns Array of objects containing function name and code
 */
export function listAssemblyFunctions(assemblyContent: string): Array<{ name: string; code: string }> {
  const functions: Array<{ name: string; code: string }> = [];
  const lines = assemblyContent.split('\n');

  let currentFunction: { name: string; startIndex: number } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Check for function start markers
    const thumbStartMatch = line.match(/glabel\s+(\w+)/);

    if (thumbStartMatch) {
      // If we were tracking a previous function, close it
      if (currentFunction) {
        const functionCode = lines.slice(currentFunction.startIndex, i).join('\n');
        functions.push({
          name: currentFunction.name,
          code: functionCode,
        });
      }

      // Start tracking new function
      const functionName = thumbStartMatch[1];
      currentFunction = {
        name: functionName,
        startIndex: i,
      };
    }
    // Check for function end markers
    else if (currentFunction) {
      const thumbEndMatch = line.match(/.size\s+(\w+)/);

      if (
        (thumbEndMatch && thumbEndMatch[1] === currentFunction.name)
      ) {
        // Include the end marker in the function code
        const functionCode = lines.slice(currentFunction.startIndex, i + 1).join('\n');
        functions.push({
          name: currentFunction.name,
          code: functionCode,
        });
        currentFunction = null;
      }
      // Check for start of next function (indicating current function ended)
      else if (line.includes('glabel')) {
        // End current function before the new function starts
        const functionCode = lines.slice(currentFunction.startIndex, i).join('\n');
        functions.push({
          name: currentFunction.name,
          code: functionCode,
        });

        // Start new function
        const newThumbMatch = line.match(/glabel\s+(\w+)/);
        const functionName = newThumbMatch ? newThumbMatch[1] : "";
        currentFunction = {
          name: functionName,
          startIndex: i,
        };
      }
    }
  }

  // Handle last function if we reached end of file
  if (currentFunction) {
    const functionCode = lines.slice(currentFunction.startIndex).join('\n');
    functions.push({
      name: currentFunction.name,
      code: functionCode,
    });
  }

  return functions;
}

/**
 * Remove a specific assembly function from a module file
 * @param modulePath The relative path from workspace root to the assembly module file
 * @param functionName The name of the function to remove
 */
export async function removeAssemblyFunction(modulePath: string, functionName: string): Promise<void> {
  // Get workspace root
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) {
    throw new Error('No workspace root found');
  }

  // Convert relative path to absolute path
  const absolutePath = path.join(workspaceRoot, modulePath);

  // Read the assembly file
  const fileUri = vscode.Uri.file(absolutePath);
  const assemblyFileBuffer = await vscode.workspace.fs.readFile(fileUri);
  const assemblyFileContent = new TextDecoder().decode(assemblyFileBuffer);

  // Find the function to remove
  const functionCode = extractAssemblyFunction(assemblyFileContent, functionName);
  if (!functionCode) {
    throw new Error(`Function "${functionName}" not found in assembly file "${modulePath}"`);
  }

  // Remove the function from the content
  const updatedContent = assemblyFileContent.replace(functionCode, '');

  // Clean up any extra blank lines that might have been left behind
  const cleanedContent = updatedContent.replace(/\n{3,}/g, '\n\n');

  // Write the modified content back to the file
  const updatedBuffer = new TextEncoder().encode(cleanedContent);
  await vscode.workspace.fs.writeFile(fileUri, updatedBuffer);

  // Save the file in VS Code editor if it's open
  const openDocument = vscode.workspace.textDocuments.find((doc) => doc.uri.fsPath === absolutePath);
  if (openDocument && openDocument.isDirty) {
    await openDocument.save();
  }
}
