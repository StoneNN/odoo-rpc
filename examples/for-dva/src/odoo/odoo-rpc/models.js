
const fields_get = async (rpc, model,allfields,attributes)=>{
        const method = 'fields_get'
        const data = await rpc.call({ model, method,args:[allfields,attributes] })
        const {code} = data
        if(!code){
            const {result} = data
            return result
        }
        else{
            return {}
        }
}

const get_one = async (cls, ins, fields)=>{
    return Object.keys(fields).reduce( async (recPromise, fld)=>{
        const item = await recPromise
        const fld_meta = cls._fields[fld]
        //console.log(fields, fld, cls._fields, fld_meta)

        if(!fld_meta){
            return item
        }

        const {type,relation} = fld_meta

        if(['many2one','one2many', 'many2many'].indexOf(type)<0 ){
            item[fld] = ins.attr(fld)
        }

        else if(type === 'many2one'){
            const other = Object.keys(fields[fld]).reduce((others, cur)=>{
                if(['id','name'].indexOf(cur)<0){
                    others.push(cur)
                }
                return others
            },[])

            const raw = ( cls._records[ins._id] || {} )[fld]
            const ref_cls = await cls.env(relation).init()

            const ref_ins = ref_cls._records[raw[0]]
//            console.log(ins,cls._name, raw, ref_ins)

            const ref = await ins.attr(fld,other.length && !ref_ins )

            item[fld] = await get_one(ref_cls, ref,fields[fld])
        }

        else{
            const m2m = await ins.attr(fld)
            const ref_cls = await cls.env(relation).init()
            item[fld] =  await get_multi(ref_cls, m2m,fields[fld])
        }

        return item


    },Promise.resolve({id:ins._id}))
}

const get_multi = (cls, instances,fields)=>{
    //console.log('cetog, mul=',instances)
    return instances.list().reduce( async (recordsPromise, ins)=>{
        const records = await recordsPromise
        const item = await get_one(cls, ins,fields)
        records.push(item)
        return records
    },Promise.resolve([]))
}

const modelCreator = (options)=>{
    const {model, fields: fields_raw, rpc, env} = options

    class cls {

        constructor(ids,vals){
            if(typeof(ids) === 'object' ){
                this._ids = ids
                this._instances = ids.reduce((acc,cur)=>{
                    acc[cur] = cls._instances[cur] || new cls(cur)
                    return acc
                },{})
            }
            else{
                this._id = ids
                if(vals){
                    const old = cls._records[ids] || {}
                    cls._records[ids] = {...old, ...vals}
                }

                if(ids){
                    cls._instances[ids] = this
                }
            }

        }

        // only for multi
        list(){ // only for multi
            return Object.values( this._instances )
        }

        // only for multi
        byid(id){ // only for multi
            return this._instances[id]
        }

        // only for multi
        view(id){ // only for multi
            return this._instances[id]
        }

        // only for single.
        attr(attr,flash=0 ){ // only for single
            const raw = ( cls._records[this._id] || {} )[attr]
            const {type,relation} = cls._fields[attr] || {}

            if(['many2one','one2many', 'many2many'].indexOf(type)<0 ){
                return raw
            }


            return cls.env(relation).init().then(ref_cls=>{
                if( type === 'many2one'){
                    if(!raw){
                        return new ref_cls()
                    }

                    if(flash){
                        return ref_cls.read(raw[0])
                    }

                    const [id, name] = raw
                    const vals = {id,name,display_name:name}
                    const ref_ins = new ref_cls(raw[0],vals)
                    return ref_ins
                }
                else{
                    if(!raw.length){
                        return new ref_cls([])
                    }

                    if(flash){
                        return ref_cls.read(raw)
                    }

                    const allin = raw.reduce((acc,cur)=>{
                         acc = acc && cur.toString() in ref_cls._instances;
                         return acc
                    },true)

                    if(!allin){
                        return ref_cls.read(raw)
                    }

                    return new ref_cls(raw)
                }

            })


        }

        look(fields){
            if( this._id ){
                return get_one(cls, this,fields)
            }
            if( this._ids ){
                return get_multi(cls, this,fields)
            }
            return []
        }

        async write( vals){
            return cls.write(this._id, vals)
        }

        async unlink(){
            return cls.unlink(this._id)
        }

    }

    Object.defineProperty(cls, 'name', {value: model, configurable: true} )

    cls._name = model
    cls._rpc = rpc
    cls._env = env
    cls._records = {}
    cls._instances = {}
    cls._fields = { id: { type: 'integer' }, name: { type: 'char' } }

    cls._fields_raw = fields_raw || ['id','name']
    cls._inited = 0

    cls.init = async() => {
        if(cls._inited){
            return cls
        }

        const fs = cls._fields_raw
        const get_fields = async ()=>{
            const fields0 = await fields_get(rpc, model,fs,['type','relation'])
            return Object.keys(fields0).reduce( (acc,cur)=>{
                if(fs.indexOf(cur)>=0 ){
                    acc[cur] = fields0[cur]
                }
                return acc
            },{})
        }

        cls._fields = await get_fields()
        cls._inited = 1

        return cls
    }

    cls.env = (relation) => {
        let ref_cls = cls._env[relation]

        if(!ref_cls){
                ref_cls = modelCreator({
                    model:relation,
                    rpc: cls._rpc,
                    env:cls._env
                })
                cls._env[relation] = ref_cls
        }

        return ref_cls

    }

    cls.call = async (method, args=[], kwargs={} ) =>{
            const params = {
                model:cls._name,
                method, args, kwargs
            }
            const data = await cls._rpc.call(params)
            const {code} = data

            if(!code){
                const {result} = data
                return result
            }

            // TBD error save in class
            return null
    }

    cls.list2instance = (result)=> {
            const res = result.reduce((acc, cur)=>{
                acc[cur.id] = ( new  cls(cur.id, cur) )
                return acc
            },{})

            const ids = Object.keys(res)
            const instance = new cls(ids)

            return instance
    }

    cls.search = async (domain)=>{
        await cls.init()
        const fields = Object.keys(cls._fields)
        const data = await cls.call('search_read',[domain,fields ])
        return cls.list2instance( data ? data : [] )
    }

    cls.read = async (ids)=>{
        await cls.init()
        const fields = Object.keys(cls._fields)
        const data0 = await cls.call('read',[ids,fields ])
        const data = data0 ? data0 : []

        if (typeof ids ==='object'){
                return cls.list2instance( data)
        }
        else{
            const vals = data.length ? data[0] : {}
            return new cls(ids, vals)

        }
    }

    cls.create = async (vals)=>{
        const data = await cls.call('create',[ vals ])
        if(data){
            return cls.read(data)
        }
        return data
    }

    cls.write = async (id, vals)=>{
        const data = await cls.call('write',[ id, vals ])
        if(data){
            return cls.read(id)
        }
        return data
    }

    cls.unlink = async (id) => {
        const data = await cls.call('unlink',[ id ])
        if(data){
            cls.view(id)._id = null
            delete cls._instances[id]
            delete cls._records[id]
            return data
        }

        return data

    }

    cls.view = (id) => {
        return cls._instances[id]
    }

    return cls

}

export default modelCreator

