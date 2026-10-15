import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import type { VSCodeProductInfo } from "./resolveVSCodeProduct";

/** Checks the exact client build and extraction paths before uploading an optional server ZIP. */
export async function readRemoteServerArchive(
    archive: string,
    client: VSCodeProductInfo,
): Promise<{ directory: string; dataFolderName: string; sha256: string }> {
    if ((await stat(archive)).size > 512 * 1024 * 1024)
        throw new Error("Remote server archive is too large.");
    const bytes = await readFile(archive);
    const zip = await JSZip.loadAsync(bytes, { createFolders: false });
    const entries = Object.values(zip.files);
    const products = entries.filter((entry) =>
        /^vscode-server-[\w-]+\/product\.json$/.test(entry.name),
    );
    if (products.length !== 1) throw new Error("Expected one remote server product.");
    const directory = products[0].name.split("/")[0];
    for (const entry of entries) {
        const original = entry.unsafeOriginalName ?? entry.name;
        if (
            original !== path.posix.normalize(original) ||
            !original.startsWith(`${directory}/`) ||
            original.includes("\\") ||
            (Number(entry.unixPermissions) & 0o170000) === 0o120000
        )
            throw new Error("Unsafe remote server archive entry.");
    }
    const product = JSON.parse(await products[0].async("string")) as VSCodeProductInfo & {
        serverDataFolderName?: string;
    };
    if (product.commit !== client.commit || product.version !== client.version)
        throw new Error("The preinstalled SSH server does not match the actual client.");
    if (!zip.file(`${directory}/bin/code-server`))
        throw new Error("Remote server executable is missing.");
    const dataFolderName = product.serverDataFolderName;
    if (
        !dataFolderName ||
        !/^[\w.-]+$/.test(dataFolderName) ||
        dataFolderName === "." ||
        dataFolderName === ".."
    )
        throw new Error("Unsafe remote server data folder.");
    return { directory, dataFolderName, sha256: createHash("sha256").update(bytes).digest("hex") };
}

/** Keeps cleanup next to remote allocation, before the client knows the returned root. */
export function createRemoteWorkspaceFixtureScript(parent = "/tmp"): string {
    return `
        const fs=require("node:fs"),path=require("node:path"),cp=require("node:child_process");
        const parent=${JSON.stringify(parent)};
        if(!path.isAbsolute(parent))throw Error("Remote fixture parent must be absolute");
        const root=fs.mkdtempSync(path.join(parent,"intelligit-ssh-workspace-"));
        try {
            const workspace=path.join(root,"workspace"),a=path.join(workspace,"a-active"),b=path.join(workspace,"b-selected");
            fs.mkdirSync(a,{recursive:true});fs.mkdirSync(path.join(root,"extension"));
            const git=(cwd,args)=>cp.execFileSync("git",args,{cwd,encoding:"utf8",stdio:["ignore","pipe","pipe"]}).trim();
            git(a,["init","-b","main"]);
            const configure=cwd=>{for(const [k,v] of Object.entries({"user.name":"IntelliGit SSH test","user.email":"ssh@example.invalid","commit.gpgSign":"false","core.hooksPath":path.join(root,"no-hooks"),"core.editor":"true","protocol.file.allow":"always"}))git(cwd,["config",k,v]);};
            configure(a);fs.writeFileSync(path.join(a,"base.txt"),"base\\n");git(a,["add","."]);git(a,["commit","-m","base"]);
            git(a,["clone","--no-hardlinks",a,b]);configure(b);
            git(b,["checkout","-b","incoming"]);fs.writeFileSync(path.join(b,"merge.txt"),"remote merge\\n");git(b,["add","."]);git(b,["commit","-m","selected incoming"]);const incoming=git(b,["rev-parse","HEAD"]);git(b,["checkout","main"]);
            fs.writeFileSync(path.join(a,"pull.txt"),"remote pull\\n");git(a,["add","."]);git(a,["commit","-m","remote advance"]);git(a,["branch","incoming"]);
            console.log(JSON.stringify({root,workspace,a,b,aHead:git(a,["rev-parse","HEAD"]),incoming}));
        } catch (error) {
            try { fs.rmSync(root,{recursive:true,force:true,maxRetries:3,retryDelay:100}); }
            catch (cleanupError) { throw new AggregateError([error,cleanupError],"Remote fixture initialization and cleanup failed"); }
            throw error;
        }
    `;
}

/** Refuses unrelated projects and symlinks before removing a disposable SSH workspace. */
export function createRemoteWorkspaceCleanupScript(root: string, parent = "/tmp"): string {
    return `
        const fs=require("node:fs"),path=require("node:path"),cp=require("node:child_process");
        const root=${JSON.stringify(root)},parent=${JSON.stringify(parent)};
        if(!path.isAbsolute(root)||path.resolve(root)!==root||
            path.dirname(root)!==path.resolve(parent)||
            !/^intelligit-ssh-workspace-[A-Za-z0-9]{6,}$/.test(path.basename(root)))
            throw Error("Unexpected cleanup root");
        let entry;
        try { entry=fs.lstatSync(root); } catch(error) { if(error.code!=="ENOENT")throw error; }
        if(entry&&(!entry.isDirectory()||entry.isSymbolicLink()||
            fs.realpathSync(root)!==path.join(fs.realpathSync(parent),path.basename(root))))
            throw Error("Unsafe cleanup root");
        const ownedProcesses=()=>cp.execFileSync("ps",["-axo","pid=,command="],{encoding:"utf8"})
            .split("\\n").flatMap(line=>{
                const match=/^\\s*(\\d+)\\s+(.*)$/.exec(line);
                return match&&match[2].includes(root+"/server/")?[Number(match[1])]:[];
            });
        for(const pid of ownedProcesses()){try{process.kill(pid,"SIGTERM")}catch(error){if(error.code!=="ESRCH")throw error;}}
        for(let attempt=0;attempt<30&&ownedProcesses().length;attempt++)
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,100);
        if(ownedProcesses().length)throw Error("Owned remote server processes did not exit");
        if(entry)fs.rmSync(root,{recursive:true,force:true,maxRetries:3,retryDelay:100});
        console.log(JSON.stringify({removed:!fs.existsSync(root),remainingProcesses:0}));
    `;
}
