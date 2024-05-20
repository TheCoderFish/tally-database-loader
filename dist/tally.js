"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.tally = void 0;
const fs = require("fs");
const path = require("path");
const process = require("process");
const http = require("http");
const yaml = require("js-yaml");
const utility_js_1 = require("./utility.js");
const logger_js_1 = require("./logger.js");
const database_js_1 = require("./database.js");
const bigquery_1 = require("@google-cloud/bigquery");
let bigquery;
class _tally {
    constructor() {
        this.lstTableMaster = [];
        this.lstTableTransaction = [];
        //hidden commandline flags
        this.importMaster = true;
        this.importTransaction = true;
        this.truncateTable = true;
        try {
            this.config = JSON.parse(fs.readFileSync('./config.json', 'utf8'))['tally'];
        }
        catch (err) {
            this.config = {
                definition: 'tally-export-config.yaml',
                server: 'localhost',
                port: 9000,
                company: '',
                fromdate: 'auto',
                todate: 'auto',
                sync: 'full'
            };
            logger_js_1.logger.logError('tally()', err);
            throw err;
        }
    }
    updateCommandlineConfig(lstConfigs) {
        try {
            if (lstConfigs.has('tally-definition'))
                this.config.definition = lstConfigs.get('tally-definition') || '';
            if (lstConfigs.has('tally-server'))
                this.config.server = lstConfigs.get('tally-server') || '';
            if (lstConfigs.has('tally-port'))
                this.config.port = parseInt(lstConfigs.get('tally-port') || '9000');
            if (lstConfigs.has('tally-fromdate') && lstConfigs.has('tally-todate')) {
                let fromDate = lstConfigs.get('tally-fromdate') || '';
                let toDate = lstConfigs.get('tally-todate') || '';
                this.config.fromdate = /^\d{4}\d{2}\d{2}$/g.test(fromDate) ? fromDate : 'auto';
                this.config.todate = /^\d{4}\d{2}\d{2}$/g.test(toDate) ? toDate : 'auto';
            }
            if (lstConfigs.has('tally-sync'))
                this.config.sync = lstConfigs.get('tally-sync') || 'full';
            if (lstConfigs.has('tally-company'))
                this.config.company = lstConfigs.get('tally-company') || '';
            //flags
            if (lstConfigs.has('tally-master'))
                this.importMaster = lstConfigs.get('tally-master') == 'true';
            if (lstConfigs.has('tally-transaction'))
                this.importTransaction = lstConfigs.get('tally-transaction') == 'true';
            if (lstConfigs.has('tally-truncate'))
                this.truncateTable = lstConfigs.get('tally-truncate') == 'true';
        }
        catch (err) {
            logger_js_1.logger.logError('tally.updateCommandlineConfig()', err);
            throw err;
        }
    }
    importData() {
        return new Promise(async (resolve, reject) => {
            var _a, _b;
            try {
                logger_js_1.logger.logMessage('Tally to Database | version: 1.0.27');
                //Load YAML export definition file
                let pathTallyExportDefinition = this.config.definition;
                if (fs.existsSync(`./${pathTallyExportDefinition}`)) {
                    let objYAML = yaml.load(fs.readFileSync(`./${pathTallyExportDefinition}`, 'utf-8'));
                    this.lstTableMaster = objYAML['master'];
                    this.lstTableTransaction = objYAML['transaction'];
                }
                else {
                    logger_js_1.logger.logMessage('Tally export definition file specified does not exists or is invalid');
                    resolve();
                    return;
                }
                if (this.config.sync == 'incremental') {
                    if (/^(mssql|mysql|postgres)$/g.test(database_js_1.database.config.technology)) {
                        //set mandatory config required for incremental sync
                        this.config.fromdate = 'auto';
                        this.config.todate = 'auto';
                        database_js_1.database.config.loadmethod = 'insert';
                        //update active company information before starting import
                        logger_js_1.logger.logMessage('Updating company information configuration table [%s]', new Date().toLocaleDateString());
                        await this.saveCompanyInfo();
                        //delete and re-create CSV folder
                        if (fs.existsSync('./csv'))
                            fs.rmSync('./csv', { recursive: true });
                        fs.mkdirSync('./csv');
                        //prepare substitution list of runtime values to reflected in TDL XML
                        let configTallyXML = new Map();
                        configTallyXML.set('fromDate', utility_js_1.utility.Date.parse(this.config.fromdate, 'yyyy-MM-dd'));
                        configTallyXML.set('toDate', utility_js_1.utility.Date.parse(this.config.todate, 'yyyy-MM-dd'));
                        configTallyXML.set('targetCompany', this.config.company ? utility_js_1.utility.String.escapeHTML(this.config.company) : '##SVCurrentCompany');
                        logger_js_1.logger.logMessage('Performing incremental sync [%s]', new Date().toLocaleString());
                        //acquire last AlterID of master & transaction from Tally (for current company)
                        let contentLastAlterIdTally = await this.postTallyXML('<?xml version="1.0" encoding="utf-8"?><ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE><ID>MyReport</ID></HEADER><BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>ASCII (Comma Delimited)</SVEXPORTFORMAT></STATICVARIABLES><TDL><TDLMESSAGE><REPORT NAME="MyReport"><FORMS>MyForm</FORMS></REPORT><FORM NAME="MyForm"><PARTS>MyPart</PARTS></FORM><PART NAME="MyPart"><LINES>MyLine</LINES><REPEAT>MyLine : MyCollection</REPEAT><SCROLLED>Vertical</SCROLLED></PART><LINE NAME="MyLine"><FIELDS>FldAlterMaster,FldAlterTransaction</FIELDS></LINE><FIELD NAME="FldAlterMaster"><SET>$AltMstId</SET></FIELD><FIELD NAME="FldAlterTransaction"><SET>$AltVchId</SET></FIELD><COLLECTION NAME="MyCollection"><TYPE>Company</TYPE><FILTER>FilterActiveCompany</FILTER></COLLECTION><SYSTEM TYPE="Formulae" NAME="FilterActiveCompany">$$IsEqual:##SVCurrentCompany:$Name</SYSTEM></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>;');
                        let lstAltId = contentLastAlterIdTally.replace(/\"/g, '').split(',');
                        let lastAlterIdMasterTally = parseInt(lstAltId[0]);
                        let lastAlterIdTransactionTally = parseInt(lstAltId[1]);
                        //acquire last AlterID of master & transaction from database
                        let lstPrimaryMasterTableNames = this.lstTableMaster.filter(p => p.nature == 'Primary').map(p => p.name);
                        let sqlQuery = 'select max(coalesce(t.alterid,0)) from (';
                        lstPrimaryMasterTableNames.forEach(p => sqlQuery += ` select max(alterid) as alterid from ${p} union`);
                        sqlQuery = utility_js_1.utility.String.strip(sqlQuery, 5);
                        sqlQuery += ') as t';
                        let lastAlterIdMasterDatabase = await database_js_1.database.executeScalar(sqlQuery) || 0;
                        let lastAlterIdTransactionDatabase = await database_js_1.database.executeScalar('select max(coalesce(alterid,0)) from trn_voucher') || 0;
                        //calculate flags to determine what changed
                        let flgIsMasterChanged = lastAlterIdMasterTally != lastAlterIdMasterDatabase;
                        let flgIsTransactionChanged = lastAlterIdTransactionTally != lastAlterIdTransactionDatabase;
                        //terminate sync if nothing has changed
                        if (!flgIsMasterChanged && !flgIsTransactionChanged) {
                            logger_js_1.logger.logMessage('  No change found');
                            return resolve();
                        }
                        //iterate through all the Primary type of tables
                        let lstPrimaryTables = [];
                        if (flgIsMasterChanged) {
                            lstPrimaryTables.push(...this.lstTableMaster.filter(p => p.nature == 'Primary'));
                        }
                        if (flgIsTransactionChanged) {
                            lstPrimaryTables.push(...this.lstTableTransaction.filter(p => p.nature == 'Primary'));
                        }
                        for (let i = 0; i < lstPrimaryTables.length; i++) {
                            let activeTable = lstPrimaryTables[i];
                            await database_js_1.database.executeNonQuery('truncate table _diff;');
                            await database_js_1.database.executeNonQuery('truncate table _delete;');
                            let tempTable = {
                                name: '',
                                collection: activeTable.collection,
                                fields: [
                                    {
                                        name: 'guid',
                                        field: 'Guid',
                                        type: 'text'
                                    },
                                    {
                                        name: 'alterid',
                                        field: 'AlterId',
                                        type: 'text'
                                    }
                                ],
                                nature: '',
                                fetch: ['AlterId'],
                                filters: activeTable.filters
                            };
                            await this.processReport('_diff', tempTable, configTallyXML);
                            await database_js_1.database.bulkLoad(path.join(process.cwd(), `./csv/_diff.data`), '_diff', tempTable.fields.map(p => p.type)); //upload to temporary table
                            fs.unlinkSync(path.join(process.cwd(), `./csv/_diff.data`)); //delete temporary file
                            //insert into delete list rows there were deleted in current data compared to previous one
                            await database_js_1.database.executeNonQuery(`insert into _delete select guid from ${activeTable.name} where guid not in (select guid from _diff);`);
                            //insert into delete list rows that were modified in current data (as they will be imported freshly)
                            await database_js_1.database.executeNonQuery(`insert into _delete select t.guid from ${activeTable.name} as t join _diff as s on s.guid = t.guid where s.alterid <> t.alterid;`);
                            //remove delete list rows from the source table
                            await database_js_1.database.executeNonQuery(`delete from ${activeTable.name} where guid in (select guid from _delete)`);
                            //iterate through each cascade delete table and delete modified rows for insertion of fresh copy
                            if (Array.isArray(activeTable.cascade_delete) && activeTable.cascade_delete.length) {
                                for (let j = 0; j < activeTable.cascade_delete.length; j++) {
                                    let targetTable = activeTable.cascade_delete[j].table;
                                    let targetField = activeTable.cascade_delete[j].field;
                                    await database_js_1.database.executeNonQuery(`delete from ${targetTable} where ${targetField} in (select guid from _delete);`);
                                }
                            }
                        }
                        // iterate through all Master tables to extract modifed and added rows in Tally data
                        if (flgIsMasterChanged) {
                            for (let i = 0; i < this.lstTableMaster.length; i++) {
                                let activeTable = this.lstTableMaster[i];
                                //add AlterID filter
                                if (!Array.isArray(activeTable.filters))
                                    activeTable.filters = [];
                                activeTable.filters.push(`$AlterID > ${lastAlterIdMasterDatabase}`);
                                let targetTable = activeTable.name;
                                await this.processReport(targetTable, activeTable, configTallyXML);
                                await database_js_1.database.bulkLoad(path.join(process.cwd(), `./csv/${targetTable}.data`), targetTable, activeTable.fields.map(p => p.type));
                                fs.unlinkSync(path.join(process.cwd(), `./csv/${targetTable}.data`)); //delete raw file
                                logger_js_1.logger.logMessage('  syncing table %s', targetTable);
                            }
                        }
                        // iterate through Transaction table to extract modifed and added rows in Tally data
                        if (flgIsTransactionChanged) {
                            for (let i = 0; i < this.lstTableTransaction.length; i++) {
                                let activeTable = this.lstTableTransaction[i];
                                //add AlterID filter
                                if (!Array.isArray(activeTable.filters))
                                    activeTable.filters = [];
                                activeTable.filters.push(`$AlterID > ${lastAlterIdTransactionDatabase}`);
                                let targetTable = activeTable.name;
                                await this.processReport(targetTable, activeTable, configTallyXML);
                                await database_js_1.database.bulkLoad(path.join(process.cwd(), `./csv/${targetTable}.data`), targetTable, activeTable.fields.map(p => p.type));
                                fs.unlinkSync(path.join(process.cwd(), `./csv/${targetTable}.data`)); //delete raw file
                                logger_js_1.logger.logMessage('  syncing table %s', targetTable);
                            }
                        }
                        if (flgIsMasterChanged) {
                            // process foreign key updates to derived table fields
                            logger_js_1.logger.logMessage('  processing foreign key updates');
                            for (let i = 0; i < lstPrimaryTables.length; i++) {
                                let activeTable = lstPrimaryTables[i];
                                if (Array.isArray(activeTable.cascade_update) && activeTable.cascade_update.length)
                                    for (let j = 0; j < activeTable.cascade_update.length; j++) {
                                        let targetTable = activeTable.cascade_update[j].table;
                                        let targetField = activeTable.cascade_update[j].field;
                                        if (database_js_1.database.config.technology == 'mssql') {
                                            await database_js_1.database.executeNonQuery(`update t set t.${targetField} = s.name from ${targetTable} as t join ${activeTable.name} as s on s.guid = t._${targetField} ;`);
                                        }
                                        else if (database_js_1.database.config.technology == 'mysql') {
                                            await database_js_1.database.executeNonQuery(`update ${targetTable} as t join ${activeTable.name} as s on s.guid = t._${targetField} set t.${targetField} = s.name ;`);
                                        }
                                        else if (database_js_1.database.config.technology == 'postgres') {
                                            await database_js_1.database.executeNonQuery(`update ${targetTable} as t set ${targetField} = s.name from ${activeTable.name} as s where s.guid = t._${targetField} ;`);
                                        }
                                        else
                                            ;
                                    }
                            }
                        }
                        if (flgIsTransactionChanged) {
                            //check if any Voucher Type is set to auto numbering
                            //automatic voucher number shifts voucher numbers of all subsequent date vouchers on insertion of in-between vouchers which requires updation
                            let countAutoNumberVouchers = await database_js_1.database.executeNonQuery(`select count(*) as c from mst_vouchertype where numbering_method like '%Auto%' ;`);
                            if (countAutoNumberVouchers) {
                                logger_js_1.logger.logMessage('  processing voucher number updates');
                                await database_js_1.database.executeNonQuery('truncate table _vchnumber;');
                                //pull list of voucher numbers for all the vouchers
                                let activeTable = this.lstTableTransaction.filter(p => p.name = 'trn_voucher')[0];
                                let lstActiveTableFilter = activeTable.filters || [];
                                lstActiveTableFilter.push('$$IsEqual:($NumberingMethod:VoucherType:$VoucherTypeName):"Automatic"');
                                if (Array.isArray(activeTable.filters))
                                    activeTable.filters.splice(activeTable.filters.length - 1, 1); //remove AlterID filter
                                let tempTable = {
                                    name: '',
                                    collection: activeTable.collection,
                                    fields: [
                                        {
                                            name: 'guid',
                                            field: 'Guid',
                                            type: 'text'
                                        },
                                        {
                                            name: 'voucher_number',
                                            field: 'VoucherNumber',
                                            type: 'text'
                                        }
                                    ],
                                    nature: '',
                                    filters: lstActiveTableFilter
                                };
                                await this.processReport('_vchnumber', tempTable, configTallyXML);
                                await database_js_1.database.bulkLoad(path.join(process.cwd(), `./csv/_vchnumber.data`), '_vchnumber', tempTable.fields.map(p => p.type)); //upload to temporary table
                                fs.unlinkSync(path.join(process.cwd(), `./csv/_vchnumber.data`)); //delete temporary file
                                //update voucher number with fresh copy
                                if (database_js_1.database.config.technology == 'mssql') {
                                    await database_js_1.database.executeNonQuery('update t set t.voucher_number = s.voucher_number from trn_voucher as t join _vchnumber as s on s.guid = t.guid;');
                                }
                                else if (database_js_1.database.config.technology == 'mysql') {
                                    await database_js_1.database.executeNonQuery('update trn_voucher as t join _vchnumber as s on s.guid = t.guid set t.voucher_number = s.voucher_number;');
                                }
                                else if (database_js_1.database.config.technology == 'postgres') {
                                    await database_js_1.database.executeNonQuery('update trn_voucher as t set voucher_number = s.voucher_number from _vchnumber as s where s.guid = t.guid;');
                                }
                                else
                                    ;
                            }
                        }
                        //erase rows for all the temporary calculation tables
                        await database_js_1.database.executeNonQuery('truncate table _diff ;');
                        await database_js_1.database.executeNonQuery('truncate table _delete ;');
                        await database_js_1.database.executeNonQuery('truncate table _vchnumber ;');
                    }
                    else
                        logger_js_1.logger.logMessage('Incremental Sync is supported only for SQL Server / MySQL / PostgreSQL');
                }
                else { // assume default as full
                    let lstTables = [];
                    if (this.importMaster) {
                        lstTables.push(...this.lstTableMaster);
                    }
                    if (this.importTransaction) {
                        lstTables.push(...this.lstTableTransaction);
                    }
                    if (/^(mssql|mysql|postgres)$/g.test(database_js_1.database.config.technology)) {
                        //update active company information before starting import
                        logger_js_1.logger.logMessage('Updating company information configuration table [%s]', new Date().toLocaleDateString());
                        await this.saveCompanyInfo();
                    }
                    else if (database_js_1.database.config.technology == 'bigquery') {
                        bigquery = new bigquery_1.BigQuery({
                            keyFilename: './bigquery-credentials.json'
                        });
                    }
                    else
                        ;
                    //prepare substitution list of runtime values to reflected in TDL XML
                    let configTallyXML = new Map();
                    configTallyXML.set('fromDate', utility_js_1.utility.Date.parse(this.config.fromdate, 'yyyy-MM-dd'));
                    configTallyXML.set('toDate', utility_js_1.utility.Date.parse(this.config.todate, 'yyyy-MM-dd'));
                    configTallyXML.set('targetCompany', this.config.company ? utility_js_1.utility.String.escapeHTML(this.config.company) : '##SVCurrentCompany');
                    if (this.truncateTable) {
                        if (/^(mssql|mysql|postgres)$/g.test(database_js_1.database.config.technology)) {
                            await database_js_1.database.truncateTables(lstTables.map(p => p.name)); //truncate tables
                        }
                    }
                    //delete and re-create CSV folder
                    if (fs.existsSync('./csv')) {
                        fs.rmSync('./csv', { recursive: true });
                    }
                    fs.mkdirSync('./csv');
                    //dump data exported from Tally to CSV file required for bulk import
                    logger_js_1.logger.logMessage('Generating CSV files from Tally [%s]', new Date().toLocaleString());
                    for (let i = 0; i < lstTables.length; i++) {
                        let timestampBegin = Date.now();
                        let targetTable = lstTables[i].name;
                        await this.processReport(targetTable, lstTables[i], configTallyXML);
                        let timestampEnd = Date.now();
                        let elapsedSecond = utility_js_1.utility.Number.round((timestampEnd - timestampBegin) / 1000, 3);
                        logger_js_1.logger.logMessage('  saving file %s.csv [%f sec]', targetTable, elapsedSecond);
                    }
                    if (/^(mssql|mysql|postgres)$/g.test(database_js_1.database.config.technology)) {
                        //perform CSV file based bulk import into database
                        logger_js_1.logger.logMessage('Loading CSV files to database tables [%s]', new Date().toLocaleString());
                        for (let i = 0; i < lstTables.length; i++) {
                            let targetTable = lstTables[i].name;
                            let rowCount = await database_js_1.database.bulkLoad(path.join(process.cwd(), `./csv/${targetTable}.data`), targetTable, lstTables[i].fields.map(p => p.type));
                            fs.unlinkSync(path.join(process.cwd(), `./csv/${targetTable}.data`)); //delete raw file
                            logger_js_1.logger.logMessage('  %s: imported %d rows', targetTable, rowCount);
                        }
                        fs.rmdirSync('./csv'); //remove directory
                    }
                    else if (database_js_1.database.config.technology == 'csv' || database_js_1.database.config.technology == 'json' || database_js_1.database.config.technology == 'bigquery' || database_js_1.database.config.technology == 'adls') {
                        if (database_js_1.database.config.technology == 'bigquery') {
                            logger_js_1.logger.logMessage('Loading CSV files to BigQuery tables [%s]', new Date().toLocaleString());
                        }
                        //remove special character of date from CSV files, which was inserted for null dates
                        for (let i = 0; i < lstTables.length; i++) {
                            let targetTable = lstTables[i].name;
                            let lstFieldTypes = lstTables[i].fields.map(p => p.type);
                            let content = fs.readFileSync(`./csv/${targetTable}.data`, 'utf-8');
                            if (database_js_1.database.config.technology == 'json') {
                                content = JSON.stringify(database_js_1.database.csvToJsonArray(content, targetTable, lstFieldTypes));
                            }
                            else {
                                content = database_js_1.database.convertCSV(content, lstFieldTypes);
                            }
                            fs.writeFileSync(`./csv/${targetTable}.${database_js_1.database.config.technology == 'json' ? 'json' : 'csv'}`, '\ufeff' + content);
                            fs.unlinkSync(`./csv/${targetTable}.data`); //delete raw file
                            if (database_js_1.database.config.technology == 'bigquery') {
                                const [job] = await bigquery.dataset(database_js_1.database.config.schema).table(targetTable).load(`./csv/${targetTable}.csv`, {
                                    sourceFormat: 'CSV',
                                    skipLeadingRows: 1,
                                    writeDisposition: 'WRITE_TRUNCATE'
                                });
                                logger_js_1.logger.logMessage('  %s: imported %d rows', targetTable, parseInt(((_b = (_a = job.statistics) === null || _a === void 0 ? void 0 : _a.load) === null || _b === void 0 ? void 0 : _b.outputRows) || '0'));
                            }
                        }
                        //upload CSV files to Azure Data Lake
                        if (database_js_1.database.config.technology == 'adls') {
                            await database_js_1.database.uploadAzureDataLake(lstTables);
                        }
                    }
                    else
                        ;
                }
                resolve();
            }
            catch (err) {
                logger_js_1.logger.logError('tally.importData()', err);
                reject(err);
            }
        });
    }
    postTallyXML(msg) {
        return new Promise((resolve, reject) => {
            try {
                let req = http.request({
                    hostname: this.config.server,
                    port: this.config.port,
                    path: '',
                    method: 'POST',
                    headers: {
                        'Content-Length': Buffer.byteLength(msg, 'utf16le'),
                        'Content-Type': 'text/xml;charset=utf-16'
                    }
                }, (res) => {
                    let data = '';
                    res
                        .setEncoding('utf16le')
                        .on('data', (chunk) => {
                        let result = chunk.toString() || '';
                        data += result;
                    })
                        .on('end', () => {
                        resolve(data);
                    })
                        .on('error', (httpErr) => {
                        logger_js_1.logger.logMessage('Unable to connect with Tally');
                        reject(httpErr);
                        logger_js_1.logger.logError('tally.postTallyXML()', httpErr);
                    });
                });
                req.on('error', (reqError) => {
                    reject(reqError);
                    logger_js_1.logger.logError('tally.postTallyXML()', reqError);
                });
                req.write(msg, 'utf16le');
                req.end();
            }
            catch (err) {
                reject(err);
                logger_js_1.logger.logError('tally.postTallyXML()', err);
            }
        });
    }
    ;
    substituteTDLParameters(msg, substitutions) {
        let retval = msg;
        try {
            substitutions.forEach((v, k) => {
                let regPtrn = new RegExp(`\\{${k}\\}`);
                if (typeof v === 'string')
                    retval = retval.replace(regPtrn, utility_js_1.utility.String.escapeHTML(v));
                else if (typeof v === 'number')
                    retval = retval.replace(regPtrn, v.toString());
                else if (v instanceof Date)
                    retval = retval.replace(regPtrn, utility_js_1.utility.Date.format(v, 'd-MMM-yyyy'));
                else if (typeof v === 'boolean')
                    retval = retval.replace(regPtrn, v ? 'Yes' : 'No');
                else
                    ;
            });
        }
        catch (err) {
            logger_js_1.logger.logError('tally.substituteTDLParameters()', err);
        }
        return retval;
    }
    processTdlOutputManipulation(txt) {
        let retval = txt;
        try {
            retval = retval.replace('<ENVELOPE>', ''); //Eliminate ENVELOPE TAG
            retval = retval.replace('</ENVELOPE>', '');
            retval = retval.replace(/\<FLDBLANK\>\<\/FLDBLANK\>/g, ''); //Eliminate blank tag
            retval = retval.replace(/\s+\r\n/g, ''); //remove empty lines
            retval = retval.replace(/\r\n/g, ''); //remove all line breaks
            retval = retval.replace(/\t/g, ' '); //replace all tabs with a single space
            retval = retval.replace(/\s+\<F/g, '<F'); //trim left space
            retval = retval.replace(/\<\/F\d+\>/g, ''); //remove XML end tags
            retval = retval.replace(/\<F01\>/g, '\r\n'); //append line break to each row start and remove first field XML start tag
            retval = retval.replace(/\<F\d+\>/g, '\t'); //replace XML start tags with tab separator
            retval = retval.replace(/&amp;/g, '&'); //escape ampersand
            retval = retval.replace(/&lt;/g, '<'); //escape less than
            retval = retval.replace(/&gt;/g, '>'); //escape greater than
            retval = retval.replace(/&quot;/g, '"'); //escape ampersand
            retval = retval.replace(/&apos;/g, "'"); //escape ampersand
            retval = retval.replace(/&tab;/g, ''); //strip out tab if any
            retval = retval.replace(/&#\d+;/g, ""); //remove all unreadable character escapes
        }
        catch (err) {
            logger_js_1.logger.logError('tally.processTdlOutputManipulation()', err);
        }
        return retval;
    }
    processReport(targetTable, tableConfig, substitutions) {
        return new Promise(async (resolve, reject) => {
            try {
                let xml = this.generateXMLfromYAML(tableConfig);
                if (substitutions && substitutions.size)
                    xml = this.substituteTDLParameters(xml, substitutions);
                let output = await this.postTallyXML(xml);
                output = this.processTdlOutputManipulation(output);
                let columnHeaders = tableConfig.fields.map(p => p.name).join('\t');
                fs.writeFileSync(`./csv/${targetTable}.data`, columnHeaders + output);
                resolve();
            }
            catch (err) {
                logger_js_1.logger.logError(`tally.processMasterReport(${targetTable})`, err);
                reject(err);
            }
        });
    }
    saveCompanyInfo() {
        return new Promise(async (resolve, reject) => {
            try {
                let xmlCompany = `<?xml version="1.0" encoding="utf-8"?><ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE><ID>MyReport</ID></HEADER><BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>ASCII (Comma Delimited)</SVEXPORTFORMAT><SVCURRENTCOMPANY>{targetCompany}</SVCURRENTCOMPANY></STATICVARIABLES><TDL><TDLMESSAGE><REPORT NAME="MyReport"><FORMS>MyForm</FORMS></REPORT><FORM NAME="MyForm"><PARTS>MyPart</PARTS></FORM><PART NAME="MyPart"><LINES>MyLine</LINES><REPEAT>MyLine : MyCollection</REPEAT><SCROLLED>Vertical</SCROLLED></PART><LINE NAME="MyLine"><FIELDS>FldGuid,FldName,FldBooksFrom,FldLastVoucherDate,FldEOL</FIELDS></LINE><FIELD NAME="FldGuid"><SET>$Guid</SET></FIELD><FIELD NAME="FldName"><SET>$$StringFindAndReplace:$Name:'"':'""'</SET></FIELD><FIELD NAME="FldBooksFrom"><SET>(($$YearOfDate:$BooksFrom)*10000)+(($$MonthOfDate:$BooksFrom)*100)+(($$DayOfDate:$BooksFrom)*1)</SET></FIELD><FIELD NAME="FldLastVoucherDate"><SET>(($$YearOfDate:$LastVoucherDate)*10000)+(($$MonthOfDate:$LastVoucherDate)*100)+(($$DayOfDate:$LastVoucherDate)*1)</SET></FIELD><FIELD NAME="FldEOL"><SET>†</SET></FIELD><COLLECTION NAME="MyCollection"><TYPE>Company</TYPE><FILTER>FilterActiveCompany</FILTER></COLLECTION><SYSTEM TYPE="Formulae" NAME="FilterActiveCompany">$$IsEqual:##SVCurrentCompany:$Name</SYSTEM></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
                if (!this.config.company) //remove complete SVCURRENTCOMPANY tag if no target company is specified
                    xmlCompany = xmlCompany.replace('<SVCURRENTCOMPANY>{targetCompany}</SVCURRENTCOMPANY>', '');
                else
                    xmlCompany = xmlCompany.replace('{targetCompany}', this.config.company);
                let strCompanyInfo = await this.postTallyXML(xmlCompany); //extract active company information
                if (strCompanyInfo.endsWith(',"†",\r\n')) {
                    strCompanyInfo = strCompanyInfo.replace(/\",\"†\",\r\n/g, '').substr(1);
                    let lstCompanyInfoParts = strCompanyInfo.split(/\",\"/g);
                    let companyName = lstCompanyInfoParts[1];
                    companyName = companyName.replace(/'/g, '\\"');
                    if (this.config.fromdate == 'auto' || this.config.todate == 'auto') { //auto assign from/to from company info for detection mode
                        this.config.fromdate = lstCompanyInfoParts[2];
                        this.config.todate = lstCompanyInfoParts[3];
                    }
                    //clear config table of database and insert active company info to config table
                    if (/^(mssql|mysql|postgres)$/g.test(database_js_1.database.config.technology)) {
                        await database_js_1.database.executeNonQuery('truncate table config;');
                        await database_js_1.database.executeNonQuery(`insert into config(name,value) values('Update Timestamp','${new Date().toLocaleString()}'),('Company Name','${companyName}'),('Period From','${this.config.fromdate}'),('Period To','${this.config.todate}');`);
                    }
                    else if (database_js_1.database.config.technology == 'bigquery') {
                        await bigquery.dataset(database_js_1.database.config.schema).createQueryJob('truncate table config');
                        await bigquery.dataset(database_js_1.database.config.schema).createQueryJob(`insert into config(name,value) values('Update Timestamp','${new Date().toLocaleString()}'),('Company Name','${companyName}'),('Period From','${this.config.fromdate}'),('Period To','${this.config.todate}');`);
                    }
                }
                else {
                    reject('Cannot detect First/Last voucher date from company');
                }
                resolve();
            }
            catch (err) {
                let errorMessage = '';
                if (err['code'] == 'ECONNREFUSED')
                    errorMessage = 'Unable to communicate with Tally of specified port';
                logger_js_1.logger.logError(`tally.saveCompanyInfo()`, errorMessage || err);
                reject('');
            }
        });
    }
    generateXMLfromYAML(tblConfig) {
        let retval = '';
        try {
            //XML header
            retval = `<?xml version="1.0" encoding="utf-8"?><ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE><ID>MyReportLedgerTable</ID></HEADER><BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>XML (Data Interchange)</SVEXPORTFORMAT><SVFROMDATE>{fromDate}</SVFROMDATE><SVTODATE>{toDate}</SVTODATE><SVCURRENTCOMPANY>{targetCompany}</SVCURRENTCOMPANY></STATICVARIABLES><TDL><TDLMESSAGE><REPORT NAME="MyReportLedgerTable"><FORMS>MyForm</FORMS></REPORT><FORM NAME="MyForm"><PARTS>MyPart01</PARTS></FORM>`;
            if (!this.config.company) //remove complete SVCURRENTCOMPANY tag if no target company is specified
                retval = retval.replace('<SVCURRENTCOMPANY>{targetCompany}</SVCURRENTCOMPANY>', '');
            else
                retval = retval.replace('{targetCompany}', utility_js_1.utility.String.escapeHTML(this.config.company));
            //Push routes list
            let lstRoutes = tblConfig.collection.split(/\./g);
            let targetCollection = lstRoutes.splice(0, 1);
            lstRoutes.unshift('MyCollection'); //add basic collection level route
            //loop through and append PART XML
            for (let i = 0; i < lstRoutes.length; i++) {
                let xmlPart = utility_js_1.utility.Number.format(i + 1, 'MyPart00');
                let xmlLine = utility_js_1.utility.Number.format(i + 1, 'MyLine00');
                retval += `<PART NAME="${xmlPart}"><LINES>${xmlLine}</LINES><REPEAT>${xmlLine} : ${lstRoutes[i]}</REPEAT><SCROLLED>Vertical</SCROLLED></PART>`;
            }
            //loop through and append LINE XML (except last line which contains field data)
            for (let i = 0; i < lstRoutes.length - 1; i++) {
                let xmlLine = utility_js_1.utility.Number.format(i + 1, 'MyLine00');
                let xmlPart = utility_js_1.utility.Number.format(i + 2, 'MyPart00');
                retval += `<LINE NAME="${xmlLine}"><FIELDS>FldBlank</FIELDS><EXPLODE>${xmlPart}</EXPLODE></LINE>`;
            }
            retval += `<LINE NAME="${utility_js_1.utility.Number.format(lstRoutes.length, 'MyLine00')}">`;
            retval += `<FIELDS>`; //field end
            //Append field declaration list
            for (let i = 0; i < tblConfig.fields.length; i++)
                retval += utility_js_1.utility.Number.format(i + 1, 'Fld00') + ',';
            retval = utility_js_1.utility.String.strip(retval, 1);
            retval += `</FIELDS></LINE>`; //End of Field declaration
            //loop through each field
            for (let i = 0; i < tblConfig.fields.length; i++) {
                let fieldXML = `<FIELD NAME="${utility_js_1.utility.Number.format(i + 1, 'Fld00')}">`;
                let iField = tblConfig.fields[i];
                //set field TDL XML expression based on type of data
                if (/^(\.\.)?[a-zA-Z0-9_]+$/g.test(iField.field)) {
                    if (iField.type == 'text')
                        fieldXML += `<SET>$${iField.field}</SET>`;
                    else if (iField.type == 'logical')
                        fieldXML += `<SET>if $${iField.field} then 1 else 0</SET>`;
                    else if (iField.type == 'date')
                        fieldXML += `<SET>if $$IsEmpty:$${iField.field} then $$StrByCharCode:241 else $$PyrlYYYYMMDDFormat:$${iField.field}:"-"</SET>`;
                    else if (iField.type == 'number')
                        fieldXML += `<SET>if $$IsEmpty:$${iField.field} then "0" else $$String:$${iField.field}</SET>`;
                    else if (iField.type == 'amount')
                        fieldXML += `<SET>$$StringFindAndReplace:(if $$IsDebit:$${iField.field} then -$$NumValue:$${iField.field} else $$NumValue:$${iField.field}):"(-)":"-"</SET>`;
                    else if (iField.type == 'quantity')
                        fieldXML += `<SET>$$StringFindAndReplace:(if $$IsInwards:$${iField.field} then $$Number:$$String:$${iField.field}:"TailUnits" else -$$Number:$$String:$${iField.field}:"TailUnits"):"(-)":"-"</SET>`;
                    else if (iField.type == 'rate')
                        fieldXML += `<SET>if $$IsEmpty:$${iField.field} then 0 else $$Number:$${iField.field}</SET>`;
                    else
                        fieldXML += `<SET>${iField.field}</SET>`;
                }
                else
                    fieldXML += `<SET>${iField.field}</SET>`;
                fieldXML += `<XMLTAG>${utility_js_1.utility.Number.format(i + 1, 'F00')}</XMLTAG>`;
                fieldXML += `</FIELD>`;
                retval += fieldXML;
            }
            retval += `<FIELD NAME="FldBlank"><SET>""</SET></FIELD>`; //Blank Field specification
            //collection
            retval += `<COLLECTION NAME="MyCollection"><TYPE>${targetCollection}</TYPE>`;
            //fetch list
            if (tblConfig.fetch && tblConfig.fetch.length)
                retval += `<FETCH>${tblConfig.fetch.join(',')}</FETCH>`;
            //filter
            if (tblConfig.filters && tblConfig.filters.length) {
                retval += `<FILTER>`;
                for (let j = 0; j < tblConfig.filters.length; j++)
                    retval += utility_js_1.utility.Number.format(j + 1, 'Fltr00') + ',';
                retval = utility_js_1.utility.String.strip(retval); //remove last comma
                retval += `</FILTER>`;
            }
            retval += `</COLLECTION>`;
            //filter
            if (tblConfig.filters && tblConfig.filters.length)
                for (let j = 0; j < tblConfig.filters.length; j++)
                    retval += `<SYSTEM TYPE="Formulae" NAME="${utility_js_1.utility.Number.format(j + 1, 'Fltr00')}">${tblConfig.filters[j]}</SYSTEM>`;
            //XML footer
            retval += `</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
        }
        catch (err) {
            logger_js_1.logger.logError(`tally.generateXMLfromYAML()`, err);
        }
        return retval;
    }
}
let tally = new _tally();
exports.tally = tally;
//# sourceMappingURL=tally.js.map