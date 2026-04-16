import { readJsonFromRoot, readJsonFromVisual, safelyParse } from "./utils.js";
import fs from 'fs-extra';
import path from 'path';
import { UserConfig } from "vite";
import { powerbiVisualPlugin, localizationPlugin } from 'vite-plugin-powerbi-visuals';
import ConsoleWriter from "./ConsoleWriter.js";
import lodashCloneDeep from 'lodash.clonedeep';
import util from 'util';
const exec = util.promisify(processExec);
import { exec as processExec } from 'child_process';
import { resolveCertificate } from "./CertificateTools.js";

const config = await readJsonFromRoot('config.json');

const visualPlugin = "visualPlugin.ts";

export interface ViteOptions {
    devMode: boolean;
    generateResources: boolean;
    generatePbiviz: boolean;
    minifyJS: boolean;
    minify: boolean;
    stats: boolean;
    compression?: number;
    devtool?: string;
    devServerPort?: number;
    fast?: boolean;
    skipApiCheck?: boolean;
    allLocales?: boolean;
    pbivizFile?: string;
    certificationAudit?: boolean;
    certificationFix?: boolean;
}

export default class ViteWrap {
    private pbiviz;
    private viteConfig: UserConfig;

    static async prepareFoldersAndFiles(visualPackage) {
        const tmpFolder = path.join(visualPackage.basePath, ".tmp");
        const precompileFolder = path.join(visualPackage.basePath, config.build.precompileFolder);
        const dropFolder = path.join(visualPackage.basePath, config.build.dropFolder);
        const packageDropFolder = path.join(visualPackage.basePath, config.package.dropFolder);
        const visualPluginFile = path.join(visualPackage.basePath, config.build.precompileFolder, visualPlugin);
        await Promise.all([
            fs.ensureDir(tmpFolder),
            fs.ensureDir(precompileFolder),
            fs.ensureDir(dropFolder),
            fs.ensureDir(packageDropFolder)
        ]);
        await fs.createFile(visualPluginFile);
    }

    static loadAPIPackage() {
        const apiPath = path.join(process.cwd(), "node_modules", "powerbi-visuals-api");
        const doesAPIExist = fs.pathExistsSync(apiPath);
        if (!doesAPIExist) {
            ConsoleWriter.error(`Can't find powerbi-visuals-api package`);
            process.exit(1);
        }
        return import("file://" + path.join(apiPath, "index.js"));
    }

    async installAPIpackage() {
        const apiVersion = this.pbiviz.apiVersion ? `~${this.pbiviz.apiVersion}` : "latest";
        try {
            ConsoleWriter.info(`Installing API: ${apiVersion}...`);
            const {
                stdout,
                stderr
            } = await exec(`npm install --save powerbi-visuals-api@${apiVersion}`);
            if (stdout) ConsoleWriter.info(stdout);
            if (stderr) ConsoleWriter.warning(stderr);
            return true;
        } catch (ex) {
            if (ex.message.indexOf("No matching version found for powerbi-visuals-api") !== -1) {
                throw new Error(`Error: Invalid API version: ${apiVersion}`);
            }
            ConsoleWriter.error(`npm install powerbi-visuals-api@${apiVersion} failed`);
            return false;
        }
    }


    enableOptimization() {
        this.viteConfig.mode = "production";
        this.viteConfig.build = {
            ...this.viteConfig.build,
            minify: true
        };
    }

    async configureDevServer(visualPackage, port = 8080) {
        const options = await resolveCertificate();

        this.viteConfig = {
            ...this.viteConfig,
            publicDir: config.server.assetsRoute,
            server: {
                ...this.viteConfig.server,
                https: {
                    key: options.key,
                    cert: options.cert,
                    pfx: options.pfx,
                    passphrase: options.passphrase
                },
                port,
                strictPort: true,
                watch: {
                    // TODO:
                },
            }
        };
    }

    configureVisualPlugin(options, tsconfig, visualPackage) {
        const visualJSFilePath = tsconfig.compilerOptions.out || tsconfig.compilerOptions.outDir;
        this.viteConfig.build = {
            ...this.viteConfig.build,
            outDir: path.join(visualPackage.basePath, config.build.dropFolder),
        };
        const visualPluginPath = path.join(process.cwd(), config.build.precompileFolder, visualPlugin);
        this.viteConfig.server.watch.ignored = [visualPluginPath];
        if (tsconfig.compilerOptions.out) {
            this.viteConfig.build.lib = {
                ...this.viteConfig.build.lib as object,
                entry: visualJSFilePath,
                fileName: () => 'visual.js',
            };
        } else {
            const libName = `${this.pbiviz.visual.guid}${options.devMode ? "_DEBUG" : ""}`;
            this.viteConfig.build.lib = {
                ...this.viteConfig.build.lib as object,
                entry: visualPluginPath,
                name: libName,
                formats: ['iife'],
                fileName: () => 'visual.js',
            };
        }
    }

    async configureCustomVisualsWebpackPlugin(visualPackage, options, tsconfig) {
        if (options.skipApiCheck) {
            ConsoleWriter.warning(`Skipping API check. Tools started with --skipApi flag.`);
        } else {
            await this.configureAPIVersion()
        }

        const api = await ViteWrap.loadAPIPackage();
        const dependenciesPath = typeof this.pbiviz.dependencies === "string" && path.join(process.cwd(), this.pbiviz.dependencies);
        let pluginConfiguration = {
            ...lodashCloneDeep(visualPackage.pbivizConfig),

            apiVersion: api.version,
            capabilitiesSchema: api.schemas.capabilities,
            pbivizSchema: api.schemas.pbiviz,
            stringResourcesSchema: api.schemas.stringResources,
            dependenciesSchema: api.schemas.dependencies,

            customVisualID: `CustomVisual_${this.pbiviz.visual.guid}`.replace(/[^\w\s]/gi, ''),
            devMode: options.devMode,
            generatePbiviz: options.generatePbiviz,
            generateResources: options.generateResources,
            minifyJS: options.minifyJS,
            dependencies: fs.existsSync(dependenciesPath) ? this.pbiviz.dependencies : null,
            modules: typeof tsconfig.compilerOptions.outDir !== "undefined",
            visualSourceLocation: path.posix.relative(config.build.precompileFolder, tsconfig.files[0]).replace(/(\.ts)x|\.ts/, ""),
            pluginLocation: path.join(config.build.precompileFolder, "visualPlugin.ts"),
            compression: options.compression,
            certificationAudit: options.certificationAudit,
            certificationFix: options.certificationFix,
        };
        return pluginConfiguration;
    }

    async configureAPIVersion() {
        //(?<=powerbi-visuals-api@) - positive look-behind to find version installed in visual and get 3 level version.
        const regexFullVersion = /(?<=powerbi-visuals-api@)((?:\d+\.?){1,3})/g;
        //get only first 2 parts of version
        const regexMajorVersion = /\d+(?:\.\d+)?/;
        let listResults;
        try {
            listResults = (await exec('npm list powerbi-visuals-api version')).stdout;
        } catch (error) {
            listResults = error.stdout;
        }
        const installedAPIVersion = listResults.match(regexFullVersion)?.[0] ?? "not found";
        const doesAPIExist = fs.pathExistsSync(path.join(process.cwd(), "node_modules", "powerbi-visuals-api"));

        // if the powerbi-visual-api package wasn't installed install the powerbi-visual-api,
        // with version from apiVersion in pbiviz.json or the latest API, if apiVersion is absent in pbiviz.json
        const isAPIConfigured = doesAPIExist && installedAPIVersion && this.pbiviz.apiVersion
        if (!isAPIConfigured || this.pbiviz.apiVersion.match(regexMajorVersion)[0] != installedAPIVersion.match(regexMajorVersion)[0]) {
            ConsoleWriter.warning(`installed "powerbi-visuals-api" version - "${installedAPIVersion}", is not match with the version specified in pbviz.json - "${this.pbiviz.apiVersion}".`);
            await this.installAPIpackage();
        }
    }


    async appendPlugins(options, visualPackage, tsconfig) {
        const pluginConfiguration = await this.configureCustomVisualsWebpackPlugin(visualPackage, options, tsconfig);

        let statsFilename = config.build.stats.split("/").pop();
        const statsLocation = config.build.stats.split("/").slice(0, -1).join(path.sep);
        statsFilename = statsFilename?.split(".").slice(0, -1).join(".");
        statsFilename = `${statsFilename}.${options.devMode ? "dev" : "prod"}.html`;

        this.viteConfig.plugins = this.viteConfig.plugins ?? [];

        if (options.stats) {
            /*this.webpackConfig.plugins.push(
                new BundleAnalyzerPlugin({
                    reportFilename: path.join(statsLocation, statsFilename),
                    openAnalyzer: false,
                    analyzerMode: `static`
                })
            );*/
        }

        this.viteConfig.plugins.push(
            powerbiVisualPlugin(pluginConfiguration),
            localizationPlugin({
                capabilitiesPath: visualPackage.pbivizConfig.capabilities,
                includeAllLocales: options.allLocales
            }),
            /*
            {
                apply: (compiler: webpack.Compiler) => {
                    compiler.hooks.afterCompile.tap('AddCapabilitiesWatch', (compilation) => {
                        const capabilitiesPath = path.resolve(process.cwd(), this.pbiviz.capabilities);
                        compilation.fileDependencies.add(capabilitiesPath);
                    });
                }
            }*/
        );
    }


    async prepareViteConfig(visualPackage, options: ViteOptions, tsconfig) {
        this.viteConfig = Object.assign({}, await import('./vite.config.js')).default;

        // Set vite mode based on devMode
        if (options.devMode) {
            this.viteConfig.mode = "development";
        }

        if (options.minifyJS) {
            this.enableOptimization();
        }

        await Promise.all([
            this.appendPlugins(options, visualPackage, tsconfig),
            this.configureDevServer(visualPackage, options.devServerPort),
            this.configureVisualPlugin(options, tsconfig, visualPackage),
            /*this.configureLoaders({
                fast: options.fast,
                includeAllLocales: options.allLocales
            }),*/
        ]);

        return this.viteConfig;
    }


    async generateViteConfig(visualPackage, options: ViteOptions = {
        devMode: false,
        generateResources: false,
        generatePbiviz: false,
        minifyJS: true,
        minify: true,
        devServerPort: 8080,
        fast: false,
        compression: 0,
        stats: true,
        skipApiCheck: false,
        allLocales: false,
        pbivizFile: 'pbiviz.json',
        certificationAudit: false,
        certificationFix: false,
    }) {
        const [tsconfig, pbiviz] = await Promise.all([
            readJsonFromVisual('tsconfig.json'),
            readJsonFromVisual(options.pbivizFile)
        ]);
        this.pbiviz = pbiviz;

        const capabilitiesPath = this.pbiviz.capabilities;
        visualPackage.pbivizConfig.capabilities = capabilitiesPath;

        const dependenciesPath = this.pbiviz.dependencies && path.join(process.cwd(), this.pbiviz.dependencies);
        const dependenciesFile = safelyParse(dependenciesPath);
        visualPackage.pbivizConfig.dependencies = typeof dependenciesFile === 'object' ? dependenciesFile : {};

        await ViteWrap.prepareFoldersAndFiles(visualPackage);

        const viteConfig = await this.prepareViteConfig(visualPackage, options, tsconfig);

        return viteConfig;
    }
}
