/** Keeps cleanup next to remote allocation, before the client knows the returned root. */
export function createRemoteWorkspaceFixtureScript(parent = "/tmp"): string {
    return `
        const fs=require("node:fs"),path=require("node:path"),cp=require("node:child_process");
        const root=fs.mkdtempSync(path.join(${JSON.stringify(parent)},"intelligit-ssh-workspace-"));
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
