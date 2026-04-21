import { createServer, build, ViteDevServer, UserConfig } from "vite";
import fs from 'fs-extra';
import path from 'path';
import ConsoleWriter from "./ConsoleWriter.js";
import { FeatureManager, Logs, Status } from "./FeatureManager.js";
import { Severity, Stage } from "./features/FeatureTypes.js";
import { readJsonFromRoot, readJsonFromVisual } from "./utils.js";
import { Visual } from "./Visual.js";
import ViteWrap, { ViteOptions } from "./ViteWrap.js";
import { LintValidator } from "./LintValidator.js";
import { LintOptions } from "./CommandManager.js";
import Package from "./Package.js";

export interface GenerateOptions {
    force: boolean;
    template: string;
}

const globalConfig = await readJsonFromRoot('config.json');
const PBIVIZ_FILE = 'pbiviz.json';

/**
 * Represents an instance of a visual package based on file path
 */
export default class VisualManager {
    public basePath: string;
    public pbivizConfig;
    public capabilities;
    public visual: Visual;
    private package: Package;
    public featureManager: FeatureManager
    public viteConfig: UserConfig;
    public compiler: Awaited<ReturnType<typeof build>>;
    private devServer: ViteDevServer;

    constructor(rootPath: string) {
        this.basePath = rootPath;
    }

    public async prepareVisual(pbivizFile: string = PBIVIZ_FILE) {
        this.pbivizConfig = await readJsonFromVisual(pbivizFile, this.basePath);

        if (this.pbivizConfig) {
            await this.createVisualInstance();
        } else {
            ConsoleWriter.error(pbivizFile + ' not found. You must be in the root of a visual project to run this command.')
            process.exit(1);
        }
        return this;
    }

    public async runLintValidation(options: LintOptions) {
        try {
            const linter = new LintValidator(options);
            await linter.runLintValidation();
        } catch (error) {
            ConsoleWriter.error("Can't run lint validation.");
            if (options.verbose) {
                ConsoleWriter.error(error.message);
            }
        }
    }


    public async createVisualInstance() {
        this.capabilities = await readJsonFromVisual("capabilities.json", this.basePath);
        this.visual = new Visual(this.capabilities, this.pbivizConfig);
    }

    public async initializeVite(viteOptions: ViteOptions) {
        const viteWrap = new ViteWrap();
        this.viteConfig = await viteWrap.generateViteConfig(this, viteOptions);

        return this;
    }

    public async generatePackage(verbose: boolean = false) {
        await build(this.viteConfig);

        this.createPackageInstance();
        const logs = this.validatePackage();
        this.outputResults(logs, verbose);
    }


    /**
     * Starts Vite server
     */
    public async startViteServer(generateDropFiles: boolean = false) {
        ConsoleWriter.blank();
        ConsoleWriter.info('Starting server...');
        try {
            // TODO
            if (true) {
                this.prepareDropFiles();
            }

            // Use build in watch mode to produce bundled IIFE output
            const buildConfig = {
                ...this.viteConfig,
                build: {
                    ...this.viteConfig.build,
                    watch: {},
                },
            };

            // Start the watching build (produces output files on each change)
            const watcher = await build(buildConfig);

            // Start dev server to serve the compiled drop files
            this.devServer = await createServer(this.viteConfig);
            this.devServer = await this.devServer.listen();
            this.devServer.printUrls();
            ConsoleWriter.info(`Server listening on port ${this.viteConfig.server!.port}`);

            process.on('SIGINT', this.stopServer);
            process.on('SIGTERM', this.stopServer);
        } catch (e) {
            ConsoleWriter.error(e.message);
            process.exit(1);
        }
    }


    /**
     * Validates the visual code
     */
    public validateVisual(verbose: boolean = false) {
        this.featureManager = new FeatureManager()
        const { status, logs } = this.featureManager.validate(Stage.PreBuild, this.visual);
        this.outputResults(logs, verbose);
        if (status === Status.Error) {
            process.exit(1);
        }

        return this;
    }

    /**
     * Validates the visual package
     */
    public validatePackage() {
        const featureManager = new FeatureManager();
        const { logs } = featureManager.validate(Stage.PostBuild, this.package);

        return logs;
    }

    /**
     * Outputs the results of the validation 
     */
    public outputResults({ errors, deprecation, warnings, info }: Logs, verbose: boolean) {
        const headerMessage = {
            error: `Visual doesn't support some features required for all custom visuals:`,
            deprecation: `Some features are going to be required soon, please update the visual:`,
            warning: `Visual doesn't support some features recommended for all custom visuals:`,
            verboseInfo: `Visual can be improved by adding some features:`,
            shortInfo: `Visual can be improved by adding ${info.length} more optional features.`
        };

        this.outputLogsWithHeadMessage(headerMessage.error, errors, Severity.Error);
        this.outputLogsWithHeadMessage(headerMessage.deprecation, deprecation, Severity.Deprecation);
        this.outputLogsWithHeadMessage(headerMessage.warning, warnings, Severity.Warning);

        const verboseSuggestion = 'Run `pbiviz package` with --verbose flag to see more details.';
        const headerInfoMessage = headerMessage[verbose ? "verboseInfo" : "shortInfo"]
        const infoLogs = (!info.length || verbose) ? info : [verboseSuggestion];
        this.outputLogsWithHeadMessage(headerInfoMessage, infoLogs, Severity.Info);
    }

    private outputLogsWithHeadMessage(headMessage: string, logs: string[], severity: Severity) {
        if (!logs.length) {
            return;
        }
        let outputLog;
        switch (severity) {
            case Severity.Deprecation:
            case Severity.Error:
                outputLog = ConsoleWriter.error;
                break;
            case Severity.Warning:
                outputLog = ConsoleWriter.warning;
                break;
            default:
                outputLog = ConsoleWriter.info;
                break;
        }

        if (headMessage) {
            outputLog(headMessage);
            ConsoleWriter.blank();
        }

        logs.forEach(error => outputLog(error));
        ConsoleWriter.blank();
    }

    private prepareDropFiles() {
        const dropFolder = path.join(this.basePath, globalConfig.build.dropFolder);
        const assets = ['visual.js', 'visual.css', 'pbiviz.json'];
        const headers = this.viteConfig.server?.headers as Record<string, string> ?? {};

        this.viteConfig.plugins = this.viteConfig.plugins ?? [];
        this.viteConfig.plugins.push({
            name: 'serve-drop-files',
            configureServer(server) {
                server.middlewares.use((req, res, next) => {
                    console.log(`Incoming request: ${req.url}`);
                    const assetName = assets.find(a => req.url?.endsWith(`/${a}`));
                    if (!assetName) return next();

                    const filePath = path.join(dropFolder, assetName);
                    fs.readFile(filePath)
                        .then(content => {
                            for (const [key, value] of Object.entries(headers)) {
                                res.setHeader(key, value);
                            }
                            res.end(content);
                            ConsoleWriter.info(`Serving ${assetName}`);
                        })
                        .catch(err => {
                            ConsoleWriter.error(`Error serving ${assetName}: ${err.message}`);
                            next();
                        });
                });
            }
        });
    }

    private async stopServer() {
        ConsoleWriter.blank();
        ConsoleWriter.info("Stopping server...");
        if (this.devServer) {
            await this.devServer.close();
            this.devServer = null;
        }
    }

    private createPackageInstance() {
        const pathToJSContent = path.join((this.pbivizConfig.build ?? globalConfig.build).dropFolder, "visual.js");
        const sourceCode = fs.readFileSync(pathToJSContent, "utf8");
        this.package = new Package(sourceCode, this.capabilities, this.visual.visualFeatureType);
    }
}